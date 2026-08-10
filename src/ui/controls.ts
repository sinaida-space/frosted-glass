import { params, type GlassParams } from '../state/params'
import { hexToLinear, linearToHex } from './color'

export interface Control {
  el: HTMLElement
  sync(): void
}

type NumKey = { [K in keyof GlassParams]: GlassParams[K] extends number ? K : never }[keyof GlassParams]
type BoolKey = { [K in keyof GlassParams]: GlassParams[K] extends boolean ? K : never }[keyof GlassParams]
type ColorKey = { [K in keyof GlassParams]: GlassParams[K] extends [number, number, number] ? K : never }[keyof GlassParams]

let idCounter = 0
function uid(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function fmt(value: number, step: number): string {
  const decimals = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0
  return value.toFixed(decimals)
}

export interface SliderOpts {
  label: string
  min: number
  max: number
  step: number
  unit?: string
}

/** Numeric slider bound to a GlassParams key. Shift-drag = 0.1x fine adjustment. */
export function slider(key: NumKey, opts: SliderOpts): Control {
  const wrap = document.createElement('div')
  wrap.className = 'fg-control fg-control--slider'

  const id = uid('fg-slider')
  const labelEl = document.createElement('label')
  labelEl.className = 'fg-control__label'
  labelEl.htmlFor = id
  labelEl.textContent = opts.label

  const valueEl = document.createElement('span')
  valueEl.className = 'fg-control__value'

  const row = document.createElement('div')
  row.className = 'fg-control__row'

  const input = document.createElement('input')
  input.type = 'range'
  input.id = id
  input.className = 'fg-slider'
  input.min = String(opts.min)
  input.max = String(opts.max)
  input.step = String(opts.step)

  // Fine adjustment state: while shift is held, drag deltas are scaled 0.1x
  // from a captured base value rather than jumping to the raw thumb position.
  let fineBase: number | null = null
  let fineStartClientX = 0

  const rawToValue = (raw: number): number => raw

  const applyFine = (raw: number, clientX: number): number => {
    if (fineBase === null) {
      fineBase = raw
      fineStartClientX = clientX
      return fineBase
    }
    const trackWidth = input.getBoundingClientRect().width || 1
    const range = opts.max - opts.min
    const dxRatio = (clientX - fineStartClientX) / trackWidth
    const delta = dxRatio * range * 0.1
    let v = fineBase + delta
    v = Math.min(opts.max, Math.max(opts.min, v))
    v = Math.round(v / opts.step) * opts.step
    return v
  }

  const commit = (value: number) => {
    const clamped = Math.min(opts.max, Math.max(opts.min, value))
    params.set(key, clamped as GlassParams[NumKey])
  }

  input.addEventListener('pointerdown', (e) => {
    fineBase = null
    if (e.shiftKey) {
      fineBase = params.get()[key] as unknown as number
      fineStartClientX = e.clientX
      // Prevent the native thumb jump-to-click so fine mode starts from the current value.
      e.preventDefault()
      input.focus()
    }
  })

  input.addEventListener('pointermove', (e) => {
    if (fineBase === null) return
    if (!e.shiftKey) {
      fineBase = null
      return
    }
    const v = applyFine(rawToValue(Number(input.value)), e.clientX)
    input.value = String(v)
    commit(v)
  })

  input.addEventListener('pointerup', () => { fineBase = null })

  input.addEventListener('input', () => {
    if (fineBase !== null) return // handled by pointermove fine path
    commit(Number(input.value))
  })

  // Dragging must not select text.
  input.addEventListener('selectstart', (e) => e.preventDefault())

  row.appendChild(input)
  row.appendChild(valueEl)
  wrap.appendChild(labelEl)
  wrap.appendChild(row)

  const sync = () => {
    const v = params.get()[key] as unknown as number
    input.value = String(v)
    const text = `${fmt(v, opts.step)}${opts.unit ? opts.unit : ''}`
    valueEl.textContent = text
    input.setAttribute('aria-valuetext', text)
  }
  sync()

  return { el: wrap, sync }
}

export interface ToggleOpts {
  label: string
}

/** Checkbox bound to a boolean GlassParams key. */
export function toggle(key: BoolKey, opts: ToggleOpts): Control {
  const wrap = document.createElement('div')
  wrap.className = 'fg-control fg-control--toggle'

  const id = uid('fg-toggle')
  const labelEl = document.createElement('label')
  labelEl.className = 'fg-control__label'
  labelEl.htmlFor = id
  labelEl.textContent = opts.label

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = id
  input.className = 'fg-toggle'

  input.addEventListener('change', () => {
    params.set(key, input.checked as GlassParams[BoolKey])
  })

  wrap.appendChild(labelEl)
  wrap.appendChild(input)

  const sync = () => {
    input.checked = params.get()[key] as unknown as boolean
  }
  sync()

  return { el: wrap, sync }
}

export interface ColorControlOpts {
  label: string
}

/** Colour picker bound to a linear-RGB [r,g,b] GlassParams key. The store is
 * linear; <input type="color"> and the hex field are sRGB, converted at the boundary. */
export function colorControl(key: ColorKey, opts: ColorControlOpts): Control {
  const wrap = document.createElement('div')
  wrap.className = 'fg-control fg-control--color'

  const id = uid('fg-color')
  const labelEl = document.createElement('label')
  labelEl.className = 'fg-control__label'
  labelEl.htmlFor = id
  labelEl.textContent = opts.label

  const row = document.createElement('div')
  row.className = 'fg-control__row'

  const picker = document.createElement('input')
  picker.type = 'color'
  picker.id = id
  picker.className = 'fg-color-picker'

  const hexField = document.createElement('input')
  hexField.type = 'text'
  hexField.className = 'fg-color-hex'
  hexField.spellcheck = false
  hexField.maxLength = 7

  const commitHex = (hex: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return
    const linear = hexToLinear(hex)
    params.set(key, linear as GlassParams[ColorKey])
  }

  picker.addEventListener('input', () => commitHex(picker.value))
  hexField.addEventListener('change', () => commitHex(hexField.value))

  row.appendChild(picker)
  row.appendChild(hexField)
  wrap.appendChild(labelEl)
  wrap.appendChild(row)

  const sync = () => {
    const rgb = params.get()[key] as unknown as [number, number, number]
    const hex = linearToHex(rgb)
    picker.value = hex
    if (document.activeElement !== hexField) hexField.value = hex
  }
  sync()

  return { el: wrap, sync }
}
