export function classState(control: { status: string; isLocked: boolean; classStartedAt: string | null; reactionConfig: { autoExpiredAt?: string | null } }, now: number) {
 const started = control.classStartedAt ? Date.parse(control.classStartedAt) : NaN
 const elapsed = Number.isFinite(started) ? Math.max(0, now - started) : 0
 const ended = control.isLocked || ['completed','closed','locked'].includes(control.status) || Boolean(control.reactionConfig.autoExpiredAt) || (Number.isFinite(started) && elapsed >= 120 * 60000)
 return { label: ended ? '終了' : Number.isFinite(started) ? elapsed >= 95 * 60000 ? '授業後' : '授業中' : '開始前', elapsedMinutes: Math.floor(elapsed / 60000), remainingMinutes: Math.max(0, Math.ceil((120 * 60000 - elapsed) / 60000)), active: !ended && Number.isFinite(started) }
}
