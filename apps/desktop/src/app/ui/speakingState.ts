import type { SpeakingNode } from "../types";
let speakingCtx: AudioContext | null = null;
const speakingNodes = new Map<string, SpeakingNode>();
let speakingRaf: number | null = null;
export const speakingState = {
  get speakingCtx() {
    return speakingCtx;
  },
  set speakingCtx(value: typeof speakingCtx) {
    speakingCtx = value;
  },
  get speakingNodes() {
    return speakingNodes;
  },
  get speakingRaf() {
    return speakingRaf;
  },
  set speakingRaf(value: typeof speakingRaf) {
    speakingRaf = value;
  },
};
