import { readFileSync } from "fs"
import { JSDOM } from "jsdom"
import path from "path"
import vm from "vm"

const html = readFileSync(path.resolve(__dirname, "../../../src/browser/pages/remote.html"), "utf8")

describe("remote shell keyboard", () => {
  let dom: JSDOM
  let input: (data: string) => void
  let sent: string[]
  let preedit: string
  let phone: { maxTouchPoints: number; vibrate?: jest.Mock }
  let saved: Map<string, string>
  let context: vm.Context
  let appCursor: boolean

  beforeEach(() => {
    jest.useFakeTimers()
    dom = new JSDOM(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""))
    sent = []
    preedit = ""
    appCursor = false
    phone = { maxTouchPoints: 1, vibrate: jest.fn(() => true) }
    saved = new Map([["kbd", "1"]])
    context = vm.createContext({
      document: dom.window.document,
      navigator: phone,
      $: (id: string) => dom.window.document.getElementById(id),
      el: (tag: string, className: string, text: string) => {
        const node = dom.window.document.createElement(tag)
        node.className = className
        node.textContent = text
        return node
      },
      storage: (key: string, value?: string) => (value === undefined ? saved.get(key) : saved.set(key, value)),
      setTimeout,
      clearTimeout,
      target: {
        deliver: (data: string) => sent.push(data),
        raw: (data: string) => sent.push(data),
        preedit: (text: string) => (preedit = text),
        appCursor: () => appCursor,
      },
    })
    input = vm.runInContext(
      html.slice(html.indexOf("const keySeq ="), html.indexOf("// Opened from the terminal, after asking:")) +
        "\nkeyboard(target)",
      context,
    )
    press("lang")
    phone.vibrate!.mockClear()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    dom.window.close()
  })

  const press = (key: string, pointerType = "touch") => {
    const node = dom.window.document.querySelector<HTMLButtonElement>(`#kbd button[data-k='${key}']`)!
    const keyboard = dom.window.document.getElementById("kbd")!
    keyboard.onpointerup!({} as PointerEvent)
    keyboard.onpointerdown!({ target: node, pointerType, preventDefault: () => {} } as unknown as PointerEvent)
  }

  it("keeps unfinished syllables local and commits the completed Hangul", () => {
    for (const key of "ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ") press(key)
    expect(sent.join("")).toBe("안녕하세")
    expect(preedit).toBe("요")
    press("space")
    jest.runAllTimers()
    expect(sent.join("")).toBe("안녕하세요 ")
  })

  it.each(["1", ",", "."])("does not compose %s as a Korean consonant", (key) => {
    for (const jamo of "ㅎㅏㄴ") press(jamo)
    press(key)
    for (const jamo of "ㅇㅓ") press(jamo)
    press("space")
    jest.runAllTimers()
    expect(sent.join("")).toBe(`한${key}어 `)
  })

  it.each(["1", ",", "."])("keeps %s followed by a vowel as separate characters", (key) => {
    press(key)
    press("ㅏ")
    press("space")
    jest.runAllTimers()
    expect(sent.join("")).toBe(`${key}ㅏ `)
  })

  it("composes lone jamo from a hardware keyboard", () => {
    for (const jamo of "ㅌㅔㅅㅡㅌㅡ") input(jamo)
    expect(sent.join("")).toBe("테스")
    expect(preedit).toBe("트")
    input("\x7f")
    expect(preedit).toBe("ㅌ")
    input("\r")
    jest.runAllTimers()
    expect(sent.join("")).toBe("테스ㅌ\r")
  })

  it("preserves fast typing order after committing a syllable", () => {
    press("ㄱ")
    press("ㅏ")
    press("space")
    press("ㄴ")
    press("ㅏ")
    press("enter")
    input("x")
    jest.runAllTimers()
    expect(sent.join("")).toBe("가 나\rx")
  })

  it("gives a short pulse for each touch without vibrating for hardware input or mouse clicks", () => {
    press("1")
    press("2")
    press("3", "mouse")
    input("x")
    expect(phone.vibrate!.mock.calls).toEqual([[8], [8]])
    expect(sent.join("")).toBe("123x")
  })

  it("remembers the vibration toggle when another shell opens", () => {
    const toggle = dom.window.document.getElementById("kbd-haptics")!
    const keys = dom.window.document.getElementById("keys")!
    const click = () => keys.onclick!({ target: toggle, pointerType: "touch" } as unknown as PointerEvent)
    click()
    expect(saved.get("kbd-vibration")).toBe("0")
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    press("1")
    expect(phone.vibrate).not.toHaveBeenCalled()
    input = vm.runInContext("keyboard(target)", context)
    press("a")
    expect(phone.vibrate).not.toHaveBeenCalled()
    click()
    expect(saved.get("kbd-vibration")).toBe("1")
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    expect(phone.vibrate).toHaveBeenCalledWith(8)
  })

  it("keeps typing working and hides the toggle without vibration support", () => {
    phone.vibrate = undefined
    input = vm.runInContext("keyboard(target)", context)
    expect(dom.window.document.getElementById("kbd-haptics")!.hidden).toBe(true)
    press("a")
    expect(sent.join("")).toBe("a")
  })

  it("preserves Hangul input when the device rejects vibration", () => {
    phone.vibrate!.mockImplementation(() => {
      throw new Error("Vibration unavailable")
    })
    press("ㄱ")
    press("ㅏ")
    press("space")
    jest.runAllTimers()
    expect(sent.join("")).toBe("가 ")
  })

  it("pulses during backspace repeat and stops when the touch is cancelled", () => {
    press("bksp")
    jest.advanceTimersByTime(460)
    expect(phone.vibrate).toHaveBeenCalledTimes(3)
    expect(sent.join("")).toBe("\x7f\x7f\x7f")
    dom.window.document.getElementById("kbd")!.onpointercancel!({} as PointerEvent)
    jest.advanceTimersByTime(1000)
    expect(phone.vibrate).toHaveBeenCalledTimes(3)
  })

  const bar = (selector: string, modifiers: Partial<PointerEvent> = {}) => {
    const target = dom.window.document.querySelector(`#keys ${selector}`)!
    dom.window.document.getElementById("keys")!.onclick!({ target, ...modifiers } as PointerEvent)
  }

  it.each([false, true])("sends Shift+Left in application cursor mode=%s and consumes one-shot Shift", (app) => {
    appCursor = app
    press("shift")
    bar('[data-key="left"]')
    bar('[data-key="left"]')
    expect(sent).toEqual(["\x1b[1;2D", app ? "\x1bOD" : "\x1b[D"])
  })

  it("keeps locked Shift active across arrow taps and combines Ctrl and Alt", () => {
    press("shift")
    press("shift")
    bar('[data-key="left"]')
    bar('[data-mod="ctrl"]')
    bar('[data-key="right"]')
    bar('[data-mod="alt"]')
    bar('[data-key="home"]')
    expect(sent).toEqual(["\x1b[1;2D", "\x1b[1;6C", "\x1b[1;4H"])
  })

  it("honors physical modifiers when clicking an arrow and retains already encoded modifiers", () => {
    bar('[data-key="left"]', { shiftKey: true, ctrlKey: true })
    input("\x1b[1;6D")
    expect(sent).toEqual(["\x1b[1;6D", "\x1b[1;6D"])
  })

  it("commits Korean composition before Shift+Left", () => {
    press("ㄱ")
    press("ㅏ")
    press("shift")
    bar('[data-key="left"]')
    jest.runAllTimers()
    expect(sent).toEqual(["가", "\x1b[1;2D"])
  })

  it("encodes modified page keys and Shift+Tab without leaving modifiers stuck", () => {
    press("shift")
    bar('[data-key="pgup"]')
    bar('[data-key="pgdn"]', { ctrlKey: true })
    press("shift")
    bar('[data-key="tab"]')
    bar('[data-key="tab"]')
    expect(sent).toEqual(["\x1b[5;2~", "\x1b[6;5~", "\x1b[Z", "\t"])
  })

  it("preserves sticky Ctrl and Alt shortcuts on the Korean layout", () => {
    bar('[data-mod="ctrl"]')
    input("ㅊ")
    bar('[data-mod="alt"]')
    input("ㅁ")
    input("z")
    expect(sent).toEqual(["\x03", "\x1ba", "z"])
  })
})
