/**
 * Pin the language the browser half reads, so its copy stops depending on the
 * machine that runs the tests.
 *
 * The panel picks its copy from the host's locale service when there is one,
 * and falls back to `navigator.language` when there is not. Two consequences
 * showed up the first time these tests ran anywhere but a Chinese Windows box:
 *
 * 1. A CI runner with `LANG=C` reports `en-US`, so every Chinese assertion in
 *    `panel.test.mjs` / `client.test.mjs` failed on copy alone.
 * 2. Node only exposes `navigator` from v21. On Node 20 — the lowest version
 *    `engines.node` allows — the global is missing entirely, the fallback lands
 *    on English, and the same assertions fail for a second, unrelated reason.
 *
 * Pinning both makes the rendered copy a property of the tests instead of a
 * property of the runner. Tests that exercise the language switch itself still
 * redefine `navigator` and restore it afterwards, which restores this value.
 *
 * @param {string} language - BCP 47 tag the panel should read, e.g. `zh-CN`.
 * @returns {() => void} restores whatever the runtime had before.
 */
export function pinNavigator(language = 'zh-CN') {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { language, languages: [language] },
    configurable: true,
    writable: true,
  })

  return () => {
    if (original === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', original)
  }
}
