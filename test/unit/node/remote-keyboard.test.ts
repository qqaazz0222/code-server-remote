import { readFileSync } from "fs"
import { JSDOM } from "jsdom"
import path from "path"
import vm from "vm"

const html = readFileSync(path.resolve(__dirname, "../../../src/browser/pages/remote.html"), "utf8")

describe("remote shell Korean keyboard", () => {
  let dom: JSDOM
  let input: (data: string) => void
  let sent: string[]
  let preedit: string

  beforeEach(() => {
    jest.useFakeTimers()
    dom = new JSDOM(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""))
    sent = []
    preedit = ""
    const context = vm.createContext({
      document: dom.window.document,
      navigator: { maxTouchPoints: 1 },
      $: (id: string) => dom.window.document.getElementById(id),
      el: (tag: string, className: string, text: string) => {
        const node = dom.window.document.createElement(tag)
        node.className = className
        node.textContent = text
        return node
      },
      storage: () => "1",
      setTimeout,
      clearTimeout,
      target: {
        deliver: (data: string) => sent.push(data),
        raw: (data: string) => sent.push(data),
        preedit: (text: string) => (preedit = text),
        appCursor: () => false,
      },
    })
    input = vm.runInContext(
      html.slice(html.indexOf("const keySeq ="), html.indexOf("// Opened from the terminal, after asking:")) +
        "\nkeyboard(target)",
      context,
    )
    press("lang")
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    dom.window.close()
  })

  const press = (key: string) => {
    const node = dom.window.document.querySelector<HTMLButtonElement>(`#kbd button[data-k='${key}']`)!
    const keyboard = dom.window.document.getElementById("kbd")!
    keyboard.onpointerup!({} as PointerEvent)
    keyboard.onpointerdown!({ target: node, preventDefault: () => {} } as unknown as PointerEvent)
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
})
