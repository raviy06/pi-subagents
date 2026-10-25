import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ACTIVITY_CHANGED_EVENT,
	type ActivityChangedPayload,
	createActivityChangeNotifier,
} from "../../src/runs/shared/activity-change-notifier.ts";

interface FakeTimer {
	id: number;
	callback: () => void;
	delayMs: number;
	unrefCalls: number;
}

function createFakeClock() {
	let currentTime = 1_000;
	let nextId = 1;
	const timers = new Map<number, FakeTimer>();
	const cleared: number[] = [];
	const setTimer = ((callback: () => void, delayMs?: number) => {
		const timer: FakeTimer = {
			id: nextId++,
			callback,
			delayMs: delayMs ?? 0,
			unrefCalls: 0,
		};
		timers.set(timer.id, timer);
		return {
			id: timer.id,
			unref() {
				timer.unrefCalls += 1;
				return this;
			},
		};
	}) as unknown as typeof setTimeout;
	const clearTimer = ((handle: unknown) => {
		const id = (handle as { id: number }).id;
		cleared.push(id);
		timers.delete(id);
	}) as unknown as typeof clearTimeout;
	return {
		now: () => currentTime,
		advance(ms: number) {
			currentTime += ms;
		},
		fireAll() {
			for (const timer of [...timers.values()]) {
				timers.delete(timer.id);
				timer.callback();
			}
		},
		get pendingCount() {
			return timers.size;
		},
		get cleared() {
			return cleared;
		},
		get timers() {
			return [...timers.values()];
		},
		setTimer,
		clearTimer,
	};
}

function createHarness(windowMs = 250) {
	const clock = createFakeClock();
	const events: Array<{ event: string; payload: ActivityChangedPayload }> = [];
	const notifier = createActivityChangeNotifier(
		(event, payload) => {
			events.push({ event, payload });
		},
		{ windowMs, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
	);
	return { clock, events, notifier };
}

describe("createActivityChangeNotifier", () => {
	it("coalesces many notify() calls inside one window into a single revision-1 event", () => {
		const { clock, events, notifier } = createHarness();
		assert.equal(notifier.revision, 0);

		for (let index = 0; index < 10; index += 1) {
			notifier.notify();
		}

		assert.equal(clock.pendingCount, 1);
		assert.equal(clock.timers[0]?.delayMs, 250);
		assert.equal(clock.timers[0]?.unrefCalls, 1);
		assert.equal(events.length, 0);

		clock.advance(250);
		clock.fireAll();

		assert.equal(events.length, 1);
		assert.equal(events[0]?.event, ACTIVITY_CHANGED_EVENT);
		assert.equal(events[0]?.payload.revision, 1);
		assert.equal(notifier.revision, 1);
	});

	it("emits a second event with revision 2 when notify() arrives after the window closes", () => {
		const { clock, events, notifier } = createHarness();

		notifier.notify();
		clock.advance(250);
		clock.fireAll();
		assert.equal(events.length, 1);

		notifier.notify();
		notifier.notify();
		assert.equal(clock.pendingCount, 1);
		clock.advance(250);
		clock.fireAll();

		assert.equal(events.length, 2);
		assert.equal(events[1]?.payload.revision, 2);
		assert.equal(notifier.revision, 2);
	});

	it("dispose() cancels the pending timer without emitting and makes later notify() a no-op", () => {
		const { clock, events, notifier } = createHarness();

		notifier.notify();
		const pendingId = clock.timers[0]?.id;
		assert.equal(clock.pendingCount, 1);

		notifier.dispose();

		assert.deepEqual(clock.cleared, [pendingId]);
		assert.equal(clock.pendingCount, 0);
		clock.fireAll();
		assert.equal(events.length, 0);

		notifier.notify();
		assert.equal(clock.pendingCount, 0);
		clock.advance(1_000);
		clock.fireAll();
		assert.equal(events.length, 0);
		assert.equal(notifier.revision, 0);
	});

	it("emits the exact payload shape with generatedAt taken from the injected clock at emit time", () => {
		const { clock, events, notifier } = createHarness(100);

		notifier.notify();
		clock.advance(100);
		clock.fireAll();

		assert.deepEqual(events, [
			{
				event: "subagents:activity:changed",
				payload: { version: 1, revision: 1, generatedAt: 1_100 },
			},
		]);
		assert.deepEqual(Object.keys(events[0]!.payload).sort(), ["generatedAt", "revision", "version"]);
	});
});
