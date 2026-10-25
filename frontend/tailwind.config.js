/** FalconMed design system — deep clinical navy, semantic status colours. */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#060B14', // app background
          900: '#0A1220',
          850: '#0C1626', // panels
          800: '#111D31',
          700: '#1A2942',
          600: '#26385A',
          500: '#3A4F75',
        },
        mist: {
          100: '#E8EEF8',
          200: '#C9D4E6',
          300: '#9DADC8',
          400: '#7387A8',
          500: '#566A8A',
        },
        brand: { DEFAULT: '#2563A8', 400: '#4C8BD6', 300: '#7FB0EA', 600: '#1D4F87' },
        ok: { DEFAULT: '#1A9068', 300: '#5CCBA2' },
        warn: { DEFAULT: '#C47D1A', 300: '#EBB461' },
        crit: { DEFAULT: '#B03030', 300: '#EE7A7A' },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { panel: '14px' },
      boxShadow: {
        panel: '0 1px 0 rgba(255,255,255,0.03) inset, 0 12px 32px -16px rgba(0,0,0,0.6)',
      },
      keyframes: {
        rise: { '0%': { opacity: 0, transform: 'translateY(6px)' }, '100%': { opacity: 1, transform: 'none' } },
        pulseDot: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
      },
      animation: {
        rise: 'rise .35s ease-out both',
        'pulse-dot': 'pulseDot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
