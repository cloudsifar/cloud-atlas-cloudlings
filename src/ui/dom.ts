// A very small helper for building DOM by hand. No framework: the UI is a few
// panels that are rebuilt from the game state whenever it changes.

type Child = Node | string | null | undefined | false

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], 'style'>
> & {
  class?: string
  /** Extra attributes (aria-*, data-*, role...). */
  attrs?: Record<string, string>
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (props) {
    const { class: className, attrs, ...rest } = props
    Object.assign(element, rest)
    if (className) element.className = className
    for (const [name, value] of Object.entries(attrs ?? {})) element.setAttribute(name, value)
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    element.append(child)
  }
  return element
}

export type Option<T extends string> = { value: T; label: string }

/** A labelled dropdown. `focusKey` lets the screen restore keyboard focus after a redraw. */
export function dropdown<T extends string>(
  label: string,
  options: Option<T>[],
  value: T,
  onChange: (value: T) => void,
  focusKey: string,
  disabled = false,
): HTMLLabelElement {
  const select = h('select', { disabled, attrs: { 'data-focus-key': focusKey } })
  for (const option of options) {
    select.append(
      h('option', {
        value: option.value,
        textContent: option.label,
        selected: option.value === value,
      }),
    )
  }
  select.onchange = () => onChange(select.value as T)
  return h('label', { class: 'field' }, h('span', { textContent: label }), select)
}

export function button(
  text: string,
  onClick: () => void,
  focusKey: string,
  className = '',
  disabled = false,
): HTMLButtonElement {
  return h('button', {
    type: 'button',
    textContent: text,
    onclick: onClick,
    class: className,
    disabled,
    attrs: { 'data-focus-key': focusKey },
  })
}

/** Replaces an element's children, keeping keyboard focus on the control with the same focus key. */
export function redraw(container: HTMLElement, ...children: Child[]): void {
  const active = document.activeElement
  const focusKey =
    active instanceof HTMLElement && container.contains(active)
      ? active.dataset.focusKey
      : undefined
  container.replaceChildren(...children.filter((child): child is Node | string => Boolean(child)))
  if (focusKey)
    container.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus()
}
