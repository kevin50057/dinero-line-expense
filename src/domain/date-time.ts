export interface ZonedMinute {
  readonly date: string;
  readonly time: string;
}

export function toInstantIso(timestamp: Date | string | number): string | null {
  const instant = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

export function toZonedMinute(
  timestamp: Date | string | number,
  timezone: string,
): ZonedMinute | null {
  const instant = timestamp instanceof Date ? timestamp : new Date(timestamp);

  if (!Number.isFinite(instant.getTime())) {
    return null;
  }

  try {
    const parts = new Intl.DateTimeFormat("en-CA-u-hc-h23", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    let hour = values.get("hour");
    const minute = values.get("minute");

    if (!year || !month || !day || !hour || !minute) {
      return null;
    }

    // A few ICU builds render midnight as 24:00 despite h23. It is the same
    // local calendar minute for our date-only representation.
    if (hour === "24") {
      hour = "00";
    }

    return {
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}`,
    };
  } catch {
    return null;
  }
}

export function parseCalendarDate(
  yearText: string,
  monthText: string,
  dayText: string,
): string | null {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseAbsoluteDateToken(token: string): string | null {
  const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/u.exec(token);
  return match ? parseCalendarDate(match[1]!, match[3]!, match[4]!) : null;
}

export function shiftCalendarDate(date: string, dayDelta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) {
    throw new TypeError(`Invalid normalized calendar date: ${date}`);
  }

  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayDelta),
  );

  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(
    shifted.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function isValidTimeToken(token: string): boolean {
  if (!/^\d{2}:\d{2}$/u.test(token)) {
    return false;
  }

  const hour = Number(token.slice(0, 2));
  const minute = Number(token.slice(3, 5));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function compareCalendarMinute(
  leftDate: string,
  leftTime: string,
  rightDate: string,
  rightTime: string,
): number {
  const left = `${leftDate}T${leftTime}`;
  const right = `${rightDate}T${rightTime}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Converts an IANA-zone wall-clock minute into a UTC ISO instant. The final
 * round-trip check rejects nonexistent local minutes during DST transitions.
 */
export function zonedLocalMinuteToInstant(
  date: string,
  time: string,
  timezone: string,
): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!dateMatch || !isValidTimeToken(time)) {
    return null;
  }

  const desiredWallClockAsUtc = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(time.slice(0, 2)),
    Number(time.slice(3, 5)),
  );
  let candidate = desiredWallClockAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = toZonedMinute(candidate, timezone);
    if (rendered === null) {
      return null;
    }
    const renderedDate = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(rendered.date);
    if (!renderedDate) {
      return null;
    }
    const renderedAsUtc = Date.UTC(
      Number(renderedDate[1]),
      Number(renderedDate[2]) - 1,
      Number(renderedDate[3]),
      Number(rendered.time.slice(0, 2)),
      Number(rendered.time.slice(3, 5)),
    );
    candidate += desiredWallClockAsUtc - renderedAsUtc;
  }

  const roundTrip = toZonedMinute(candidate, timezone);
  if (roundTrip?.date !== date || roundTrip.time !== time) {
    return null;
  }

  return new Date(candidate).toISOString();
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
