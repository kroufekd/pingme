import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeField } from '@/components/app/time-field'

function mouse(fine: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: fine, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  })
}

function Field({ start = '23:10', min, onSubmit = vi.fn() }: { start?: string; min?: string; onSubmit?: () => void }) {
  const [value, setValue] = useState(start)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <TimeField value={value} onChange={setValue} min={min} />
    </form>
  )
}

const pop = (c: HTMLElement) => c.querySelector('.tf-pop')
const item = (c: HTMLElement, col: 0 | 1, text: string) =>
  Array.from(c.querySelectorAll('.tf-col')[col].querySelectorAll('button')).find((b) => b.textContent === text)!

beforeEach(() => mouse(true))
afterEach(() => cleanup())

describe('time field', () => {
  it('with a mouse a click opens hours and minutes; the minute picks and closes', () => {
    const view = render(<Field />)
    const input = screen.getByLabelText('Time')
    expect(pop(view.container)).not.toHaveClass('on')
    fireEvent.click(input)
    expect(pop(view.container)).toHaveClass('on')
    expect(item(view.container, 0, '23')).toHaveClass('on')
    expect(item(view.container, 1, '10')).toHaveClass('on')

    fireEvent.click(item(view.container, 0, '09'))
    expect(input).toHaveValue('09:10')
    expect(pop(view.container)).toHaveClass('on')
    fireEvent.click(item(view.container, 1, '30'))
    expect(input).toHaveValue('09:30')
    expect(pop(view.container)).not.toHaveClass('on')
  })

  it('Enter and Escape close it, and Enter does not send the form while it is open', () => {
    const onSubmit = vi.fn()
    const view = render(<Field onSubmit={onSubmit} />)
    const input = screen.getByLabelText('Time')
    fireEvent.click(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(pop(view.container)).not.toHaveClass('on')
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(pop(view.container)).not.toHaveClass('on')
    fireEvent.click(input)
    fireEvent.pointerDown(document.body)
    expect(pop(view.container)).not.toHaveClass('on')
  })

  it('a typed time off the five-minute grid still shows as chosen; past times are dimmed', () => {
    const view = render(<Field start="14:07" min="14:20" />)
    fireEvent.click(screen.getByLabelText('Time'))
    expect(item(view.container, 1, '07')).toHaveClass('on')
    expect(item(view.container, 0, '13')).toHaveClass('past')
    expect(item(view.container, 0, '15')).not.toHaveClass('past')
    expect(item(view.container, 1, '15')).toHaveClass('past')
    expect(item(view.container, 1, '25')).not.toHaveClass('past')
  })

  it('on a phone there is no list: the native wheel does the job', () => {
    mouse(false)
    const view = render(<Field />)
    fireEvent.click(screen.getByLabelText('Time'))
    expect(pop(view.container)).toBeNull()
  })
})
