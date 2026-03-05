import { motion } from 'framer-motion'
import { Sparkles, Loader2 } from 'lucide-react'

export function ImageGeneratingLoader(): React.JSX.Element {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-primary/10 bg-gradient-to-br from-muted/50 to-background px-5 py-4 shadow-sm">
      {/* 动态光效背景 (Shimmer Effect) */}
      <motion.div
        className="absolute inset-0 -skew-x-12 bg-gradient-to-r from-transparent via-primary/5 to-transparent"
        animate={{
          x: ['-100%', '200%']
        }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: 'linear',
          repeatDelay: 0.5
        }}
      />

      <div className="relative flex items-center gap-4">
        {/* 图标容器 */}
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-background shadow-sm ring-1 ring-border/50">
          <motion.div
            animate={{
              scale: [1, 1.15, 1],
              rotate: [0, 10, -10, 0]
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: 'easeInOut'
            }}
          >
            <Sparkles className="size-5 text-primary fill-primary/10" />
          </motion.div>
          
          {/* 外部微光光环 */}
          <motion.div
            className="absolute inset-0 rounded-xl bg-primary/10"
            animate={{
              opacity: [0, 0.5, 0],
              scale: [1, 1.2, 1]
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: 'easeOut'
            }}
          />
        </div>

        {/* 文字内容 */}
        <div className="flex flex-col justify-center gap-0.5">
          <div className="flex items-center gap-1">
            <span className="text-sm font-medium text-foreground">Generating image</span>
            <span className="flex">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  animate={{ opacity: [0, 1, 0] }}
                  transition={{
                    duration: 1.5,
                    repeat: Infinity,
                    delay: i * 0.2,
                    ease: 'easeInOut'
                  }}
                >
                  .
                </motion.span>
              ))}
            </span>
          </div>
          <div className="flex items-center gap-1.5 overflow-hidden">
            <Loader2 className="size-3 animate-spin text-muted-foreground/70" />
            <span className="text-xs text-muted-foreground/80">AI is painting...</span>
          </div>
        </div>
      </div>
    </div>
  )
}
