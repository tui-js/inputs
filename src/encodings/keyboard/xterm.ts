import { type KeyEvent, keyEvent } from "./shared.ts";

import { Char } from "../../chars.ts";
import { decodeBuffer, maybeMultiple } from "../../decode.ts";

const textDecoder = new TextDecoder();

/**
 * Keyboard XTerm UTF-8 Keys
 *
 * @example
 * `a`
 * `þ`
 * `\x1bą`
 * `\x18@są`
 * `\x18@s\x1bą`
 */
export function decodeXTermUtf8Key(buffer: Uint8Array): null | [KeyEvent, ...KeyEvent[]] {
  // Legacy modifier encoding:
  //  - "\x1b" at the second last position signifies pressed alt.
  //  - "\x18@s" ast the start signifies pressed meta key.
  //  - Character is always encoded at the last position.
  const meta = buffer[0] === Char["CANCEL"] && buffer[1] === Char["@"] && buffer[2] === Char["s"];
  const alt = (meta && buffer[3] == Char["ESC"]) || (buffer.length > 1 && buffer[0] === Char["ESC"]);
  const startPos = (alt ? 1 : 0) + (meta ? 3 : 0);
  const charByte = buffer[startPos];

  if (typeof charByte === "undefined") {
    return null;
  }

  // "!"..="@" | "["..="~"
  if (
    (charByte >= Char["!"] && charByte <= Char["@"]) ||
    (charByte >= Char["["] && charByte <= Char["~"])
  ) {
    const character = String.fromCharCode(charByte);
    return maybeMultiple(keyEvent(character, { meta, alt }), buffer, startPos + 1);
  }

  // "A"..="Z"
  if (charByte >= Char["A"] && charByte <= Char["Z"]) {
    const character = String.fromCharCode(charByte);
    return maybeMultiple(keyEvent(character, { shift: true, meta, alt }), buffer, startPos + 1);
  }

  let key: string;
  let ctrl = false;
  // deno-fmt-ignore
  switch (charByte) {
    // "\x00"
    case Char["NULL"]:
      ctrl = true;
      key = "space";
      break;
    // " "
    case Char["SPACE"]: key = "space"; break;
    // "\n"
    //
    // Ctrl+J is normally used to send NL/LF (same as Ctrl+I or Return).
    // However instead of sending "\r" it sends "\n".
    // This behavior seems to be followed by every major terminal.
    // We use it then to distinguish it as "j" being pressed with at least ctrl
    case Char["LF"]:
      ctrl = true;
      key = "j";
      break;
    // "\r"
    case Char["CR"]: key = "return"; break;
    // "\x1b"
    case Char["ESC"]: key = "escape"; break;
    // "\b", "\x7f"
    case Char["Backspace"]:
    case Char["DEL"]: key = "backspace"; break;
    // "\t"
    case Char["Tab"]: key = "tab"; break;
    // ctrl + "a"..="z"
    //
    // When ctrl is held while typing any character between "a" to "z" its charcode is offset by 96.
    // This means that some characters have exactly the same buffer, e.g. Ctrl+I = Tab, Ctrl+M = Return.
    default:
      if (charByte >= (Char["a"] - 96) && charByte <= (Char["z"] - 96)) {
        return maybeMultiple(keyEvent(String.fromCharCode(charByte + 96), { ctrl: true, meta, alt }), buffer, startPos + 1);
      } else {
        // Number of leading 1s in first byte tells us how many codepoints the character contains
        // deno-fmt-ignore
        const codePoints =
          (charByte & 0xf0) === 0xf0 ? 4 :
          (charByte & 0xe0) === 0xe0 ? 3 :
          (charByte & 0xc0) === 0xc0 ? 2 : 1;

        // Buffer has been cut
        if (buffer.length < codePoints) {
          return null
        }

        // Definitely multiple characters
        if (buffer.length > startPos + codePoints) {
          const character = textDecoder.decode(buffer.slice(startPos, startPos + codePoints));
          // We have to check whether it is lower case as well, since there are characters that dont have casings e.g. emojis
          const shift = character.toUpperCase() === character && character.toLowerCase() !== character;

          const event = keyEvent(character, { shift, meta, alt });
          event.push(...decodeBuffer(buffer.slice(startPos + codePoints)));
          return event
        }

        // Definitely singular character
        const character = textDecoder.decode(buffer);
        const shift = character.toUpperCase() === character && character.toLowerCase() !== character;
        return keyEvent(character, { shift, meta, alt });
      }
  }

  return maybeMultiple(keyEvent(key, { ctrl, meta, alt }), buffer, startPos + 1);
}

/**
 * Returns a KeyPress with calculated modifiers
 * Modifiers byte is a char "1"..="9", so we convert it to a number first.
 * We also offset it by 1 (thus -49, not -48) to be able to bitmask it easily.
 */
function modifierKeypress(key: string, modifiers: number): [KeyEvent] {
  modifiers -= Char["0n"] + 1;
  const meta = modifiers === 0 || !!(modifiers & 8);
  const shift = !!(modifiers & 1);
  const alt = !!(modifiers & 2);
  const ctrl = !!(modifiers & 4);
  return keyEvent(key, { meta, shift, alt, ctrl });
}

/**
 * Keyboard XTERM SS3 Special keys
 *
 * Caller has to make sure that first two chars of the buffer are ["\x1b", "O"].
 *
 * ESC O ...
 */
export function decodeXTermSS3FunctionKeys(buffer: Uint8Array): null | [KeyEvent, ...KeyEvent[]] {
  // Shift + Return | F1..=F4 (SS3 prefix )
  // Shift + Return produces this code for some reason
  if (buffer[2] === Char["M"]) {
    return maybeMultiple(keyEvent("return", { shift: true }), buffer, 3);
  }

  // If F key is encoded at the third position
  // then it has no modifiers
  if (buffer[2] > Char["O"]) {
    const fKey = buffer[2] - Char["O"];
    return maybeMultiple(keyEvent(`f${fKey}`), buffer, 3);
  }

  if (buffer.length < 4) return null;

  const fKey = buffer[3] - Char["O"];
  return maybeMultiple(modifierKeypress(`f${fKey}`, buffer[2]), buffer, 4);
}

/**
 * Keyboard XTERM CSI Special keys
 *
 * Caller has to make sure that first two chars of the buffer are ["\x1b", "["].
 *
 * CSI ...
 */
export function decodeXTermCSIFunctionKeys(buffer: Uint8Array): null | [KeyEvent, ...KeyEvent[]] {
  // FIXME: Terminals which support kitty protocol use 8 as a bit for the meta key.
  //        This can cause some keys to return null when multiple modifier keys are pressed
  //        since they take 2 characters (e.g. 8 | 4 -> 12) instead of just one.

  // Home | End | Shift+Tab | Arrows
  if (
    (buffer[2] === Char["Z"] || (buffer[2] >= Char["A"] && buffer[2] <= Char["H"])) ||
    (buffer[3] === Char[";"] && (buffer[5] >= Char["A"] && buffer[5] <= Char["H"]))
  ) {
    // If fourth character is a semicolon (";") then it has encoded modifiers
    const hasModifiers = buffer[3] === Char[";"];

    let key: string;
    // deno-fmt-ignore
    switch (buffer[hasModifiers ? 5 : 2]) {
          case Char["A"]: key = "up"; break;
          case Char["B"]: key = "down"; break;
          case Char["C"]: key = "right"; break;
          case Char["D"]: key = "left"; break;

          case Char["F"]: key = "end"; break;
          case Char["H"]: key = "home"; break;

          case Char["Z"]: return maybeMultiple(keyEvent("tab", { shift: true }), buffer, 3);

          default: return null;
        }

    if (hasModifiers) {
      return maybeMultiple(modifierKeypress(key, buffer[4]), buffer, 6);
    }
    return maybeMultiple(keyEvent(key), buffer, 3);
  }

  // Insert | Delete | PageUp | PageDown
  if (buffer[3] === Char["~"] || (buffer[3] == Char[";"] && buffer[5] === Char["~"])) {
    let key: string;
    // deno-fmt-ignore
    switch (buffer[2]) {
      case Char["2n"]: key = "insert"; break;
      case Char["3n"]: key = "delete"; break;

      case Char["5n"]: key = "pageup"; break;
      case Char["6n"]: key = "pagedown"; break;

      default: return null;
    }

    // If 4th character is a semicolon (";"), then it encodes modifiers
    if (buffer[3] === Char[";"]) {
      return maybeMultiple(modifierKeypress(key, buffer[4]), buffer, 6);
    }
    return maybeMultiple(keyEvent(key), buffer, 4);
  }

  // F1..=F4 (without modifiers)
  // e.g. "\x1b[P"
  if (buffer[3] !== Char[";"]) {
    const fKey = buffer[2] - Char["O"];
    if (fKey > 0 && fKey < 5) {
      return maybeMultiple(keyEvent(`f${fKey}`), buffer, 3);
    }
  }

  // To decode F1..=F12 key events later on
  // we need at least 6 characters in the buffer
  // otherwise its either invalid or incomplete sequence
  if (buffer.length < 5) {
    return null;
  }

  // F1..=F4 (with modifiers)
  // e.g. "\x1b[1;1P"
  let fKey = buffer[5] - Char["O"];
  if (fKey > 0 && fKey < 5) {
    return maybeMultiple(modifierKeypress(`f${fKey}`, buffer[4]), buffer, 6);
  }

  // Whoever designed this is a maniac?
  // F5  – CSI 1 5 ~
  // F6  – CSI 1 7 ~ <- ???
  // F7  – CSI 1 8 ~
  // F8  – CSI 1 9 ~
  // F9  – CSI 2 0 ~
  // F10 - CSI 2 1 ~
  // F11 - CSI 2 3 ~ <- ???
  // F12 - CSI 2 4 ~
  if (buffer[2] === Char["1n"]) {
    fKey = buffer[3] - Char["0n"];
    if (fKey > 5) fKey--;
  } else if (buffer[2] === Char["2n"]) {
    // We are starting from 0 and its F9, so we add 9
    fKey = buffer[3] - Char["0n"] + 9;
    if (fKey > 10) fKey--;
  } else {
    // Invalid function key sequence
    // Possibly incomplete sequence of a different key
    return null;
  }

  // If 5th character is a semicolon (";"), then it encodes modifiers
  if (buffer[4] === Char[";"]) {
    // Invalid or incomplete sequence, missing tilde ending
    if (buffer[6] !== Char["~"]) return null;

    return maybeMultiple(modifierKeypress(`f${fKey}`, buffer[5]), buffer, 7);
  }

  // Invalid or incomplete sequence, missing tilde ending
  if (buffer[4] !== Char["~"]) return null;

  return maybeMultiple(keyEvent(`f${fKey}`), buffer, 5);
}
