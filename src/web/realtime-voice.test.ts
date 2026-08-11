import { describe, expect, it } from "vitest";
import { RealtimeVoiceTracker, voiceEventError } from "./realtime-voice";

describe("Android-safe Realtime voice tracking", () => {
  it("shows input transcript deltas and persists when final events arrive out of order", () => {
    const tracker = new RealtimeVoiceTracker();
    tracker.handle({ type: "input_audio_buffer.speech_started", item_id: "item-1" });
    expect(
      tracker.handle({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-1",
        delta: "Asere, ",
      }).userText,
    ).toBe("Asere, ");
    tracker.handle({
      type: "response.output_audio_transcript.done",
      transcript: "¡Dime, qué volá!",
    });
    tracker.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "Asere, ¿me oyes?",
    });
    expect(tracker.takeCompletedTurn()).toEqual({
      userText: "Asere, ¿me oyes?",
      assistantText: "¡Dime, qué volá!",
    });
  });

  it("does not combine a persisted turn with the next turn", () => {
    const tracker = new RealtimeVoiceTracker();
    tracker.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "First",
    });
    tracker.handle({
      type: "response.output_audio_transcript.done",
      transcript: "Answer one",
    });
    expect(tracker.takeCompletedTurn()?.userText).toBe("First");
    tracker.handle({ type: "input_audio_buffer.speech_started", item_id: "two" });
    tracker.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "two",
      transcript: "Second",
    });
    expect(tracker.snapshot()).toMatchObject({
      userText: "Second",
      assistantText: "",
    });
  });

  it("preserves an interrupted assistant transcript when the user barges in", () => {
    const tracker = new RealtimeVoiceTracker();
    tracker.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "Stop there",
    });
    tracker.handle({
      type: "response.output_audio_transcript.delta",
      delta: "The part you heard before interrupting.",
    });
    tracker.handle({ type: "input_audio_buffer.speech_started", item_id: "two" });
    expect(tracker.takeCompletedTurn()).toEqual({
      userText: "Stop there",
      assistantText: "The part you heard before interrupting.",
    });
    expect(tracker.snapshot().userText).toBe("");
  });

  it("surfaces the dedicated transcription failure instead of failing silently", () => {
    expect(
      voiceEventError({
        type: "conversation.item.input_audio_transcription.failed",
        error: { message: "Audio was unintelligible" },
      }),
    ).toContain("transcription failed: Audio was unintelligible");
  });
});
