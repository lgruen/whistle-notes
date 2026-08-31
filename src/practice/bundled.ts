/**
 * The melodies that are in the app already, so practice mode works on the first
 * tap.
 *
 * An empty library is a wall. Recording a target needs a quiet room and a
 * microphone that behaves; importing one needs a MIDI file the user does not
 * have on their phone. Neither is a good first thirty seconds, and both are the
 * wrong thing to be debugging when what you actually wanted was to find out
 * whether you can whistle a tune back.
 *
 * ## Copyright
 *
 * Everything here is unambiguously public domain, and deliberately so — this is
 * a public repository. "Ah! vous dirai-je, maman" (the Twinkle tune) is French,
 * printed 1761. "Merrily We Roll Along" (Mary Had a Little Lamb) and "Frère
 * Jacques" are traditional and were in print by the early nineteenth century.
 * Beethoven's Ninth is 1824 and the Bagatelle in A minor 1810; the composer died
 * in 1827, so both are clear everywhere in the world. Nothing here is an
 * arrangement of anyone's edition: they are the bare tunes, one note at a time,
 * written out from the melody itself.
 *
 * ## Pitch and rhythm
 *
 * Written at their ordinary pitch, in the octave around middle C, and left
 * there. `range.ts` moves a target into the whistler's own register when it
 * plays, which is one octave shift decided from a measurement rather than a
 * guess baked into a data file — and it means these read as the notes a piano
 * would play, which is the other half of what this app is for.
 *
 * Durations are in seconds at a comfortable practice tempo (a quarter note is
 * 0.6 s, i.e. 100 bpm) rather than in beats, because a target has no tempo
 * field: `TargetNote.durSec` is real time, and something has to have decided it.
 * Rests are not represented — the model has no slot for them — so a phrase's
 * final note simply carries the length of the phrase ending.
 *
 * Pure data: no DOM, no storage.
 */

import type { TargetNote } from "./align.js";

/** A quarter note at 100 bpm. Every length below is a multiple of it. */
const Q = 0.6;

/** Shorthand: pitch and length in quarter notes. */
function n(midi: number, beats = 1): TargetNote {
  return { midi, durSec: beats * Q };
}

export interface BundledMelody {
  /** Stable across versions: used as the button's `data-` value. */
  id: string;
  name: string;
  notes: readonly TargetNote[];
}

/**
 * Easiest first.
 *
 * The order is the whole curriculum this file contains. "Mary Had a Little
 * Lamb" is five stepwise notes inside a fourth and is the one a beginner can
 * actually get right on the first attempt; "Für Elise" alternates a semitone
 * and then leaps, which is the interval profile this user's own transcriptions
 * say is hardest. Starting with the one you can do is not a courtesy — it is
 * what makes the diagnosis mean anything, because an attempt that fails
 * everywhere says nothing about which interval is the problem.
 */
export const BUNDLED_MELODIES: readonly BundledMelody[] = [
  {
    id: "mary",
    name: "Mary Had a Little Lamb",
    // E D C D | E E E· | D D D· | E G G·
    notes: [
      n(64), n(62), n(60), n(62),
      n(64), n(64), n(64, 2),
      n(62), n(62), n(62, 2),
      n(64), n(67), n(67, 2),
    ],
  },
  {
    id: "twinkle",
    name: "Twinkle, Twinkle, Little Star",
    // C C G G | A A G· | F F E E | D D C·
    notes: [
      n(60), n(60), n(67), n(67),
      n(69), n(69), n(67, 2),
      n(65), n(65), n(64), n(64),
      n(62), n(62), n(60, 2),
    ],
  },
  {
    id: "frere-jacques",
    name: "Frère Jacques",
    // C D E C | C D E C | E F G· | E F G·
    notes: [
      n(60), n(62), n(64), n(60),
      n(60), n(62), n(64), n(60),
      n(64), n(65), n(67, 2),
      n(64), n(65), n(67, 2),
    ],
  },
  {
    id: "ode-to-joy",
    name: "Ode to Joy",
    // E E F G | G F E D | C C D E | E· D· D
    notes: [
      n(64), n(64), n(65), n(67),
      n(67), n(65), n(64), n(62),
      n(60), n(60), n(62), n(64),
      n(64, 1.5), n(62, 0.5), n(62, 2),
    ],
  },
  {
    id: "fur-elise",
    name: "Für Elise (opening)",
    // The alternating semitone, then the drop — nine notes and then it stops,
    // because the tenth is where the phrase would need a rest this model
    // cannot write.
    notes: [
      n(76, 0.5), n(75, 0.5), n(76, 0.5), n(75, 0.5), n(76, 0.5),
      n(71, 0.5), n(74, 0.5), n(72, 0.5), n(69, 1.5),
    ],
  },
];

export function bundledMelody(id: string): BundledMelody | null {
  return BUNDLED_MELODIES.find((melody) => melody.id === id) ?? null;
}
