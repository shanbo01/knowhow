(() => {
  "use strict";

  // Input types that hold no typed text, so nothing is ever read from them.
  const UNTYPED_INPUT_TYPES = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ]);

  // Names, ids, labels and placeholders that mark a field as a credential even
  // when the page never says so through `type` or `autocomplete`.
  const CREDENTIAL_FIELD_HINT =
    /pass(?:word|phrase|code)|user[\s_-]?name|\blogin\b|\botp\b|one[\s-]?time|verification[\s-]?code|security[\s-]?(?:code|answer|question)|\bcvv\b|\bcvc\b|card[\s-]?number|\bssn\b|social[\s-]?security|\bpin\b|\bsecrets?\b|\btoken\b|api[\s-]?key|account[\s-]?number|routing[\s-]?number/i;

  const USERNAME_HINT = /user[\s_-]?name|\blogin\b/i;

  // What an account identifier is called when it is not spelled out.
  const ACCOUNT_IDENTIFIER_HINT =
    /\buser\b|\busername\b|\blogin\b|e-?mail|\baccount\b|\bhandle\b/i;

  /**
   * Decides how much of a field may be recorded, from signals a caller reads
   * off the DOM. Kept free of the DOM itself so the rule that protects
   * credentials can be tested directly.
   *
   *   "text"      — ordinary field; the typed value may be recorded
   *   "password"  — never read
   *   "username"  — never read
   *   "protected" — another credential-shaped field; never read
   *   null        — not an editable text field at all
   */
  function classifyField(signals) {
    const tag = String(signals?.tag || "").toUpperCase();
    const inputType = String(signals?.inputType || "text").toLowerCase();
    const isTextInput = tag === "INPUT" && !UNTYPED_INPUT_TYPES.has(inputType);
    if (
      !isTextInput &&
      tag !== "TEXTAREA" &&
      signals?.contentEditable !== true
    ) {
      return null;
    }
    if (isTextInput && inputType === "password") return "password";

    const autocomplete = String(signals?.autocomplete || "").toLowerCase();
    if (autocomplete.includes("password")) return "password";
    if (autocomplete === "username") return "username";
    if (
      autocomplete === "one-time-code" ||
      autocomplete.startsWith("cc-") ||
      signals?.redactAttribute === true
    ) {
      return "protected";
    }

    const hint = String(signals?.hint || "");
    if (hint && CREDENTIAL_FIELD_HINT.test(hint)) {
      return USERNAME_HINT.test(hint) ? "username" : "protected";
    }

    // A field standing beside a password is the account that password belongs
    // to — but only when it actually looks like one. Treating every field in a
    // form that happens to ask for a password as the username threw away the
    // name, the address and the amount on every sign-up and checkout page,
    // which is most of the typing an author does.
    if (signals?.inCredentialForm === true) {
      const soleTextField = Number(signals?.formTextFieldCount) <= 1;
      if (
        soleTextField ||
        inputType === "email" ||
        autocomplete === "email" ||
        ACCOUNT_IDENTIFIER_HINT.test(hint)
      ) {
        return "username";
      }
    }

    return "text";
  }

  function typedStepCopy(kind, text, name) {
    if (kind === "password") {
      return {
        title: "Enter your password",
        instructions: "Enter your password in " + name + ".",
      };
    }
    if (kind === "username") {
      return {
        title: "Enter your username",
        instructions: "Enter your username in " + name + ".",
      };
    }
    if (kind !== "text" || !text) {
      return {
        title: "Type into " + name,
        instructions: "Type the value you need into " + name + ".",
      };
    }
    const quoted = '"' + text.replace(/"/g, "'") + '"';
    return {
      title: "Type " + quoted + " into " + name,
      instructions: "Type " + quoted + " into " + name + ".",
    };
  }

  // Keys that mean an action on their own. Everything else pressed without a
  // modifier is somebody typing, and belongs to the typed-text path — which
  // reads the finished value once, rather than watching the keystrokes.
  const ACTION_KEY_LABELS = Object.freeze({
    Enter: "Enter",
    NumpadEnter: "Enter",
    Escape: "Esc",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "Page Up",
    PageDown: "Page Down",
    " ": "Space",
  });

  const BARE_MODIFIER_KEYS = new Set([
    "Control",
    "Shift",
    "Alt",
    "Meta",
    "OS",
    "AltGraph",
    "CapsLock",
    "Dead",
  ]);

  function functionKeyLabel(key) {
    return /^F([1-9]|1[0-2])$/.test(String(key || "")) ? String(key) : null;
  }

  function shortcutKeyLabel(key) {
    const raw = String(key || "");
    const named = ACTION_KEY_LABELS[raw] || functionKeyLabel(raw);
    if (named) return named;
    // A single character is only ever a shortcut alongside a real modifier, so
    // it names the chord rather than revealing anything typed.
    if ([...raw].length === 1) return raw.toUpperCase();
    return null;
  }

  /**
   * Decides whether a key press is a shortcut worth recording, and what to call
   * it. Never sees, and never reports, the content of what somebody types: a
   * bare printable key returns null, and a password field returns null whatever
   * was pressed.
   */
  function classifyShortcut(signals) {
    if (signals?.repeat === true) return null;
    const key = String(signals?.key || "");
    if (!key || BARE_MODIFIER_KEYS.has(key)) return null;
    if (signals?.fieldKind === "password") return null;

    const ctrl = signals?.ctrlKey === true;
    const meta = signals?.metaKey === true;
    const alt = signals?.altKey === true;
    const shift = signals?.shiftKey === true;
    const chorded = ctrl || meta || alt;

    const label = shortcutKeyLabel(key);
    if (!label) return null;

    const named = Boolean(ACTION_KEY_LABELS[key] || functionKeyLabel(key));
    if (!chorded) {
      // Enter and Tab inside a field are how people leave one, not steps of
      // their own — the typed value and whatever they do next already say it.
      if (!named) return null;
      if (signals?.inEditableField === true) return null;
    }

    const keys = [];
    if (ctrl) keys.push("Ctrl");
    if (alt) keys.push(signals?.isMac === true ? "Option" : "Alt");
    if (shift) keys.push("Shift");
    if (meta) keys.push(signals?.isMac === true ? "Cmd" : "Win");
    keys.push(label);
    return { keys, label: keys.join(" + ") };
  }

  function shortcutStepCopy(shortcut) {
    const label = String(shortcut?.label || "").trim() || "a keyboard shortcut";
    return {
      title: "Press " + label,
      instructions: "Press " + label + ".",
    };
  }

  globalThis.__KNOWHOW_TYPED_FIELDS__ = Object.freeze({
    untypedInputTypes: UNTYPED_INPUT_TYPES,
    classifyField,
    typedStepCopy,
    classifyShortcut,
    shortcutStepCopy,
  });
})();
