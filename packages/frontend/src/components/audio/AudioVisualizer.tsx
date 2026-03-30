import { motion } from 'framer-motion';
import { useAudioStore } from '../../state/audio-store.js';

export function AudioVisualizer() {
  const isPlaying = useAudioStore(s => s.isPlaying);

  if (!isPlaying) return null;

  return (
    <div className="flex items-center gap-1 h-4">
      {[0, 1, 2, 3, 4].map(i => (
        <motion.div
          key={i}
          className="w-0.5 bg-[var(--color-accent)] rounded-full"
          animate={{
            height: isPlaying ? [4, 16, 8, 14, 6] : [4, 4, 4, 4, 4],
          }}
          transition={{
            duration: 0.8,
            repeat: Infinity,
            repeatType: 'reverse',
            delay: i * 0.15,
          }}
        />
      ))}
    </div>
  );
}
