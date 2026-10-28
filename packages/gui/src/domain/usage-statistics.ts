import type { UsageSnapshot } from "../shared/data-statistics.ts";

export function dateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function shiftDate(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}
export function formatTokens(value: number): string {
	if (value >= 100000000)
		return `${(value / 100000000).toLocaleString("zh-CN", { maximumFractionDigits: 1, useGrouping: false })} 亿`;
	if (value >= 10000)
		return `${(value / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1, useGrouping: false })} 万`;
	return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
export function usageStreak(dates: string[], now = new Date()): { current: number; longest: number } {
	const activity = new Set(dates);
	let current = 0;
	for (let day = now; activity.has(dateKey(day)); day = shiftDate(day, -1)) current++;
	let longest = 0;
	let count = 0;
	let previous = "";
	for (const date of [...activity].filter((day) => day <= dateKey(now)).sort()) {
		const day = new Date(`${date}T12:00:00`);
		count = dateKey(shiftDate(day, -1)) === previous ? count + 1 : 1;
		longest = Math.max(longest, count);
		previous = date;
	}
	return { current, longest };
}

// 日期按本机日历推进，避免夏令时切换造成一天偏移。
export function usageSeries(snapshot: UsageSnapshot, count: number, now = new Date()) {
	const dates = Array.from({ length: count }, (_, index) => dateKey(shiftDate(now, index - count + 1)));
	const totals = new Map<string, { key: string; label: string; tokens: number; values: number[] }>();
	for (const day of snapshot.daily) {
		const index = dates.indexOf(day.date);
		if (index < 0) continue;
		const key = JSON.stringify([day.provider, day.model]);
		const value = totals.get(key) ?? { key, label: day.model, tokens: 0, values: dates.map(() => 0) };
		value.tokens += day.tokens;
		value.values[index] += day.tokens;
		totals.set(key, value);
	}
	return { dates, models: [...totals.values()].sort((a, b) => b.tokens - a.tokens) };
}
