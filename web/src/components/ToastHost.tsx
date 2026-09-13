import { motion, AnimatePresence } from 'framer-motion'
import { useToast } from '@/store/toastStore'
import { cn } from '@/lib/utils'

const styles: Record<string, string> = {
  info: 'border-violet-400/40 text-violet-900 dark:text-violet-100',
  success: 'border-emerald-400/40 text-emerald-100',
  error: 'border-red-400/40 text-red-700 dark:text-red-100',
}

export default function ToastHost() {
  const toasts = useToast((s) => s.toasts)
  const dismiss = useToast((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed right-4 top-16 z-[70] flex w-[320px] flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            onClick={() => dismiss(t.id)}
            className={cn(
              'pointer-events-auto cursor-pointer rounded-xl border bg-slate-900/90 px-3 py-2 text-sm shadow-xl backdrop-blur',
              styles[t.kind],
            )}
          >
            <div className="font-medium">{t.title}</div>
            {t.msg && <div className="mt-1 text-xs opacity-80">{t.msg}</div>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
