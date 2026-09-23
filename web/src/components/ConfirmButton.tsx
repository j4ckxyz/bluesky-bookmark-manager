import { useEffect, useState, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  /** Label shown after the first click, while waiting for the second. */
  confirmLabel: string
  onConfirm: () => void
  className?: string
  disabled?: boolean
  'aria-label'?: string
}

/** How long the armed state lasts before it quietly resets. */
const ARM_MS = 4000

/**
 * A destructive button that needs two clicks: the first arms it and swaps the
 * label, the second runs the action. It disarms on its own or on blur, so a
 * stray click never does anything by itself.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  className = '',
  disabled,
  'aria-label': ariaLabel,
}: Props) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), ARM_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  return (
    <button
      type="button"
      className={`button button--danger ${armed ? 'button--armed' : ''} ${className}`.trim()}
      disabled={disabled}
      aria-label={armed ? confirmLabel : ariaLabel}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
