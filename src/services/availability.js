/**
 * availability.js — turns a weekly working-hours template into bookable
 * slots, and books them.
 *
 * This is the one place "is this business open, and is this particular
 * slot free" gets answered, for three callers: the dashboard's slot
 * preview, the dashboard's manual "book for a walk-in" form, and the
 * chatbot's booking tool (see ai.js). All three go through getAvailableSlots
 * / bookAppointment so they can never disagree about what counts as free.
 *
 * "Free" is the AND of three independent checks, in order from cheapest to
 * most expensive:
 *   1. Inside the account's configured working hours for that weekday.
 *   2. Not already claimed by another row in our own `appointments` table
 *      (this is what makes booking correct even when Google Calendar isn't
 *      connected, and is re-checked at booking time to close the race
 *      between "list slots" and "book slot").
 *   3. Not busy on the account's Google Calendar, if one is connected
 *      (best-effort — see google-calendar.js; a Calendar outage never
 *      blocks a booking that the internal table would otherwise allow).
 */
const {
    getAvailabilitySettings, saveAvailabilitySettings, countOverlappingAppointments,
    listAppointments, listCustomerConfirmedAppointments, createAppointment, countAppointments,
    cancelAppointment: dbCancelAppointment
} = require('./database');
const { getBusyBlocks, createAppointmentEvent, cancelAppointmentEvent } = require('./google-calendar');
const { zonedWallTimeToUtc, utcToZonedParts, isValidTimeZone, formatInZone } = require('../utils/tz');
const { ValidationError, toSqliteUtc, assertHHMM, normalizeWorkingDays, LIMITS } = require('../utils/validate');

const DEFAULTS = {
    workingDays: [1, 2, 3, 4, 5], // Mon–Fri (0 = Sunday)
    startTime: '09:00',
    endTime: '18:00',
    slotDurationMinutes: 30,
    bufferMinutes: 0,
    timezone: 'Asia/Kolkata',
    bookingEnabled: false
};

const MIN_SLOT_MINUTES = 5;
const MAX_SLOT_MINUTES = 8 * 60;
const MAX_DAYS_AHEAD = 30;
const DEFAULT_DAYS_AHEAD = 7;
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_CAP = 200;
// Don't offer a slot starting less than this soon — gives a real business
// owner a moment's notice instead of "your appointment starts right now".
const MIN_LEAD_MINUTES = 15;

/** The account's saved weekly hours, or the built-in defaults if it has never configured any (see the availability_settings table comment in database.js). */
async function getSettings(userId) {
    const row = await getAvailabilitySettings(userId);
    if (!row) return { ...DEFAULTS };
    return {
        workingDays: String(row.working_days).split(',').map(Number).filter(n => Number.isInteger(n)),
        startTime: row.start_time,
        endTime: row.end_time,
        slotDurationMinutes: row.slot_duration_minutes,
        bufferMinutes: row.buffer_minutes,
        timezone: row.timezone,
        bookingEnabled: !!row.booking_enabled
    };
}

/** Validates and persists a new weekly template. Throws ValidationError on bad input. */
async function saveSettings(userId, input) {
    const workingDays = normalizeWorkingDays(input.workingDays, 'workingDays');
    const startTime = assertHHMM(input.startTime, 'startTime');
    const endTime = assertHHMM(input.endTime, 'endTime');

    const slotDurationMinutes = Number(input.slotDurationMinutes);
    if (!Number.isInteger(slotDurationMinutes) || slotDurationMinutes < MIN_SLOT_MINUTES || slotDurationMinutes > MAX_SLOT_MINUTES) {
        throw new ValidationError(`slotDurationMinutes must be an integer between ${MIN_SLOT_MINUTES} and ${MAX_SLOT_MINUTES}.`, 'slotDurationMinutes');
    }

    let bufferMinutes = input.bufferMinutes === undefined ? 0 : Number(input.bufferMinutes);
    if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > MAX_SLOT_MINUTES) {
        throw new ValidationError('bufferMinutes must be a non-negative integer.', 'bufferMinutes');
    }

    const timezone = String(input.timezone || DEFAULTS.timezone).trim();
    if (!isValidTimeZone(timezone)) {
        throw new ValidationError(`"${timezone}" is not a recognized timezone.`, 'timezone');
    }

    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    if (endH * 60 + endM <= startH * 60 + startM) {
        throw new ValidationError('endTime must be after startTime.', 'endTime');
    }

    const bookingEnabled = !!input.bookingEnabled;

    await saveAvailabilitySettings(userId, { workingDays, startTime, endTime, slotDurationMinutes, bufferMinutes, timezone, bookingEnabled });
    return await getSettings(userId);
}

/** Every working-hours slot start/end (as UTC Date objects) over the next `daysAhead` days, before any busy/booked filtering. */
function generateCandidateSlots(settings, { daysAhead = DEFAULT_DAYS_AHEAD, now = new Date() } = {}) {
    const [startH, startM] = settings.startTime.split(':').map(Number);
    const [endH, endM] = settings.endTime.split(':').map(Number);
    const dayStartMin = startH * 60 + startM;
    const dayEndMin = endH * 60 + endM;
    const stepMin = settings.slotDurationMinutes + settings.bufferMinutes;
    const earliestStart = new Date(now.getTime() + MIN_LEAD_MINUTES * 60000);

    // Anchor on "today" in the business's own timezone, not the server's.
    const nowParts = utcToZonedParts(now, settings.timezone);
    const slots = [];

    for (let d = 0; d <= daysAhead; d++) {
        // Walk the date forward by constructing UTC-noon-of-that-day-plus-d
        // and re-reading its zoned Y/M/D — avoids any local-clock DST edge
        // cases the naive "add 24h" approach can hit.
        const dayAnchor = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + d, 12, 0, 0));
        const dayParts = utcToZonedParts(dayAnchor, settings.timezone);

        if (!settings.workingDays.includes(dayParts.weekday)) continue;

        for (let minuteOfDay = dayStartMin; minuteOfDay + settings.slotDurationMinutes <= dayEndMin; minuteOfDay += stepMin) {
            const startUtc = zonedWallTimeToUtc(dayParts.year, dayParts.month, dayParts.day, 0, minuteOfDay, settings.timezone);
            if (startUtc.getTime() < earliestStart.getTime()) continue;
            const endUtc = new Date(startUtc.getTime() + settings.slotDurationMinutes * 60000);
            slots.push({ startUtc, endUtc });
        }
    }

    slots.sort((a, b) => a.startUtc - b.startUtc);
    return slots;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
}

function formatLocalDateKey(date, timeZone) {
    const p = utcToZonedParts(date, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Distributes slots evenly across all open days when there are more free slots
 * than `maxResults`, so future days (2-7+ days ahead) are never starved by day 0/1.
 */
function pickSlotsAcrossDays(free, timeZone, maxResults) {
    if (free.length <= maxResults) return free;
    const byDay = new Map();
    for (const slot of free) {
        const key = formatLocalDateKey(slot.startUtc, timeZone);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(slot);
    }
    const picked = [];
    const queues = Array.from(byDay.values());
    let idx = 0;
    while (picked.length < maxResults) {
        let addedAny = false;
        for (const q of queues) {
            if (idx < q.length) {
                picked.push(q[idx]);
                addedAny = true;
                if (picked.length >= maxResults) break;
            }
        }
        if (!addedAny) break;
        idx++;
    }
    picked.sort((a, b) => a.startUtc - b.startUtc);
    return picked;
}

/**
 * Live, bookable slots for the next `daysAhead` days (or a specific `date` YYYY-MM-DD):
 * working hours minus whatever's already booked internally and (best-effort) busy on
 * Google Calendar, respecting both slot duration and bufferMinutes.
 */
async function getAvailableSlots(userId, { daysAhead = DEFAULT_DAYS_AHEAD, maxResults = DEFAULT_MAX_RESULTS, date = null } = {}) {
    const targetDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? date.trim() : null;
    const days = targetDate
        ? MAX_DAYS_AHEAD
        : Math.min(Math.max(1, Number(daysAhead) || DEFAULT_DAYS_AHEAD), MAX_DAYS_AHEAD);
    const cap = Math.min(Math.max(1, Number(maxResults) || DEFAULT_MAX_RESULTS), MAX_RESULTS_CAP);
    const settings = await getSettings(userId);
    let candidates = generateCandidateSlots(settings, { daysAhead: days });
    if (targetDate) {
        candidates = candidates.filter(s => formatLocalDateKey(s.startUtc, settings.timezone) === targetDate);
    }
    if (candidates.length === 0) return { settings, slots: [] };

    const bufferMs = (settings.bufferMinutes || 0) * 60000;
    const rangeStart = new Date(candidates[0].startUtc.getTime() - bufferMs);
    const rangeEnd = new Date(candidates[candidates.length - 1].endUtc.getTime() + bufferMs);

    const [busyBlocks, existing] = await Promise.all([
        getBusyBlocks(userId, rangeStart.toISOString(), rangeEnd.toISOString()),
        listAppointments(userId, {
            status: 'confirmed',
            fromAt: toSqliteUtc(rangeStart),
            toAt: toSqliteUtc(rangeEnd)
        })
    ]);

    const busy = busyBlocks.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
    const booked = existing.map(a => ({ start: new Date(a.start_at), end: new Date(a.end_at) }));

    const free = candidates.filter(slot => {
        const winStart = new Date(slot.startUtc.getTime() - bufferMs);
        const winEnd = new Date(slot.endUtc.getTime() + bufferMs);
        const hitsBusy = busy.some(b => rangesOverlap(winStart, winEnd, b.start, b.end));
        if (hitsBusy) return false;
        return !booked.some(b => rangesOverlap(winStart, winEnd, b.start, b.end));
    });

    const selected = targetDate ? free.slice(0, cap) : pickSlotsAcrossDays(free, settings.timezone, cap);

    return {
        settings,
        slots: selected.map(s => ({
            startIso: s.startUtc.toISOString(),
            endIso: s.endUtc.toISOString(),
            label: formatInZone(s.startUtc, settings.timezone)
        }))
    };
}

/**
 * Re-validates and books a specific slot. Throws with `.code` set so callers
 * (the API route, the chatbot tool loop) can distinguish "bad input" from
 * "someone else took it" from "outside working hours".
 */
function isValidSlotBoundary(settings, start) {
    const parts = utcToZonedParts(start, settings.timezone);
    if (parts.second !== 0) return false;
    if (!settings.workingDays.includes(parts.weekday)) return false;

    const [startH, startM] = settings.startTime.split(':').map(Number);
    const [endH, endM] = settings.endTime.split(':').map(Number);
    const dayStartMin = startH * 60 + startM;
    const dayEndMin = endH * 60 + endM;
    const minuteOfDay = parts.hour * 60 + parts.minute;

    if (minuteOfDay < dayStartMin) return false;
    if (minuteOfDay + settings.slotDurationMinutes > dayEndMin) return false;

    const stepMin = settings.slotDurationMinutes + settings.bufferMinutes;
    return (minuteOfDay - dayStartMin) % stepMin === 0;
}

async function bookAppointment(userId, { phone, contactName = '', startIso, notes = '', source = 'chatbot' }) {
    if (!phone) throw new ValidationError('phone is required.', 'phone');
    const start = new Date(startIso);
    if (isNaN(start.getTime())) {
        const err = new ValidationError('startIso is not a valid date/time.', 'startIso');
        err.code = 'INVALID_SLOT';
        throw err;
    }

    const settings = await getSettings(userId);
    const end = new Date(start.getTime() + settings.slotDurationMinutes * 60000);

    if (start.getTime() < Date.now()) {
        const err = new Error('That slot is in the past.');
        err.code = 'SLOT_IN_PAST';
        throw err;
    }

    if (!isValidSlotBoundary(settings, start)) {
        const err = new Error('That is not one of the available appointment slots.');
        err.code = 'INVALID_SLOT';
        throw err;
    }

    if ((await countAppointments(userId)) >= LIMITS.MAX_APPOINTMENTS_PER_USER) {
        const err = new Error(`You've reached the limit of ${LIMITS.MAX_APPOINTMENTS_PER_USER} appointments. Cancel some old ones before booking more.`);
        err.code = 'APPOINTMENT_LIMIT';
        throw err;
    }

    const bufferMs = (settings.bufferMinutes || 0) * 60000;
    const startSql = toSqliteUtc(start);
    const endSql = toSqliteUtc(end);
    const startBuf = new Date(start.getTime() - bufferMs);
    const endBuf = new Date(end.getTime() + bufferMs);

    if ((await countOverlappingAppointments(userId, toSqliteUtc(startBuf), toSqliteUtc(endBuf))) > 0) {
        const err = new Error('That slot was just booked by someone else. Please pick another.');
        err.code = 'SLOT_TAKEN';
        throw err;
    }

    const busy = await getBusyBlocks(userId, startBuf.toISOString(), endBuf.toISOString());
    if (busy.length > 0) {
        const err = new Error('That slot conflicts with an existing calendar event.');
        err.code = 'SLOT_TAKEN';
        throw err;
    }

    const trimmedNotes = String(notes || '').slice(0, LIMITS.APPOINTMENT_NOTES);

    const calendarEventId = await createAppointmentEvent(userId, {
        phone, contactName, startIso: start.toISOString(), endIso: end.toISOString(), notes: trimmedNotes
    });

    const appointment = await createAppointment(userId, {
        phone, contactName, startAt: startSql, endAt: endSql, source, notes: trimmedNotes, calendarEventId
    });

    if (!appointment) {
        if (calendarEventId) await cancelAppointmentEvent(userId, calendarEventId);
        const err = new Error('That slot was just booked by someone else. Please pick another.');
        err.code = 'SLOT_TAKEN';
        throw err;
    }

    return appointment;
}

/** Lists a customer's confirmed appointments formatted in the business timezone. */
async function getCustomerAppointments(userId, phone) {
    if (!phone) return [];
    const [settings, rows] = await Promise.all([
        getSettings(userId),
        listCustomerConfirmedAppointments(userId, phone)
    ]);
    return rows.map(r => ({
        id: r.id,
        startIso: new Date(r.start_at).toISOString(),
        endIso: new Date(r.end_at).toISOString(),
        label: formatInZone(new Date(r.start_at), settings.timezone),
        notes: r.notes || ''
    }));
}

/** Cancels an appointment (or marks it rescheduled) and best-effort removes its calendar event. */
async function cancelAppointment(userId, id, newStatus = 'cancelled') {
    const row = await dbCancelAppointment(userId, id, newStatus);
    if (row && row.calendar_event_id) {
        await cancelAppointmentEvent(userId, row.calendar_event_id);
    }
    return row;
}

/** Finds and cancels a customer's confirmed appointment by ID or earliest upcoming. */
async function cancelCustomerAppointment(userId, { phone, appointmentId = null }) {
    if (!phone) throw new ValidationError('phone is required.', 'phone');
    const confirmed = await listCustomerConfirmedAppointments(userId, phone);
    if (!confirmed.length) {
        const err = new Error('No confirmed appointment found for this customer.');
        err.code = 'NOT_FOUND';
        throw err;
    }
    const target = appointmentId
        ? confirmed.find(a => Number(a.id) === Number(appointmentId))
        : (confirmed.find(a => new Date(a.start_at).getTime() >= Date.now()) || confirmed[0]);
    if (!target) {
        const err = new Error('That confirmed appointment was not found for this customer.');
        err.code = 'NOT_FOUND';
        throw err;
    }
    return await cancelAppointment(userId, target.id, 'cancelled');
}

/**
 * Reschedules a customer's confirmed appointment: books the new slot first
 * (so a conflict never drops the existing booking), then marks the old one
 * as 'rescheduled' and removes its old Google Calendar event.
 */
async function rescheduleAppointment(userId, { phone, contactName = '', appointmentId = null, newStartIso, notes = '', source = 'chatbot' }) {
    if (!phone) throw new ValidationError('phone is required.', 'phone');
    const confirmed = await listCustomerConfirmedAppointments(userId, phone);
    if (!confirmed.length) {
        const err = new Error('No confirmed appointment found to reschedule.');
        err.code = 'NOT_FOUND';
        throw err;
    }
    const oldAppt = appointmentId
        ? confirmed.find(a => Number(a.id) === Number(appointmentId))
        : (confirmed.find(a => new Date(a.start_at).getTime() >= Date.now()) || confirmed[0]);
    if (!oldAppt) {
        const err = new Error('That confirmed appointment was not found to reschedule.');
        err.code = 'NOT_FOUND';
        throw err;
    }

    const newAppointment = await bookAppointment(userId, {
        phone,
        contactName: contactName || oldAppt.contact_name || '',
        startIso: newStartIso,
        notes: notes || oldAppt.notes || '',
        source
    });

    const oldAppointment = await cancelAppointment(userId, oldAppt.id, 'rescheduled');
    return { oldAppointment, newAppointment };
}

module.exports = {
    DEFAULTS,
    getSettings,
    saveSettings,
    getAvailableSlots,
    getCustomerAppointments,
    bookAppointment,
    cancelAppointment,
    cancelCustomerAppointment,
    rescheduleAppointment
};
