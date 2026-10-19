# File preview samples

Open this folder in the **Files** view to try the raw/preview toggle. Inline `code with **stars**` stays as is,
*italic*, __bold__ and ~~struck~~ text render.

## Lists

- [ ] Task not done
- [x] Task done
- Item that wraps
  onto a second line

1. First
2. Second

> A quote with a [link](https://code-server.dev) and a [relative link](nested/notes.md).

## Table

| Name  | Type | Size |
| ----- | :--: | ---: |
| a.csv | CSV  | 1 KB |
| b.yml | YAML | 2 KB |

## Code

```ts
const greet = (name: string) => `<b>Hello ${name}</b>`
```

## Image (relative path)

![Logo](nested/logo.svg)

<script>alert("raw HTML shows as text")</script>

[Blocked link](javascript:alert(1))

---

The end.
