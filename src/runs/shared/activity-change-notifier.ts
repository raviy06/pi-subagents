export const ACTIVITY_CHANGED_EVENT = "subagents:activity:changed" as const;

export interface ActivityChangedPayload {
	version: 1;
	revision: number;
	generatedAt: number;
}

export interface ActivityChangeNotifier {
	notify(): void;
	dispose(): void;
	readonly revision: number;
}

export interface ActivityChangeNotifierOptions {
	windowMs?: number;
	now?: () => number;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
}

const DEFAULT_WINDOW_MS = 250;

export function createActivityChangeNotifier(
	emit: (event: string, payload: ActivityChangedPayload) => void,
	options: ActivityChangeNotifierOptions = {},
): ActivityChangeNotifier {
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? setTimeout;
	const clearTimer = options.clearTimer ?? clearTimeout;

	let revision = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const flush = (): void => {
		pending = undefined;
		revision += 1;
		emit(ACTIVITY_CHANGED_EVENT, { version: 1, revision, generatedAt: now() });
	};

	return {
		get revision() {
			return revision;
		},
		notify() {
			if (disposed || pending !== undefined) return;
			pending = setTimer(flush, windowMs);
			// Coalescing timers must never keep the host process alive.
			if (typeof pending === "object" && pending !== null && "unref" in pending) {
				pending.unref();
			}
		},
		dispose() {
			disposed = true;
			if (pending !== undefined) {
				clearTimer(pending);
				pending = undefined;
			}
		},
	};
}
