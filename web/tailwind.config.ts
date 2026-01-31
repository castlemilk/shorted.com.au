/** @type {import('tailwindcss').Config} */

const { fontFamily } = require("tailwindcss/defaultTheme")

module.exports = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  // Optimize CSS output
  corePlugins: {
    preflight: true,
  },
  // Remove unused styles more aggressively
  safelist: [
    // Keep these classes even if not detected
    'dark',
    'loaded',
    // Animation utilities
    'animate-in',
    'fade-in',
    'slide-in-from-bottom-2',
    'slide-in-from-bottom-3',
    'slide-in-from-bottom-4',
    'slide-in-from-bottom-5',
    'slide-in-from-left-2',
    'slide-in-from-top-2',
    'zoom-in-95',
    // Terminal effects
    'text-glow',
    'box-glow',
    'scanlines',
    'phosphor-in',
  ],
  theme: {
  	container: {
  		center: true,
  		padding: '2rem',
  		screens: {
  			'2xl': '1400px'
  		}
  	},
  	extend: {
  		fontFamily: {
  			sans: [
  				'var(--font-sans)',
                    ...fontFamily.mono
                ],
  			display: [
  				'var(--font-display)',
                    ...fontFamily.sans
                ],
  			mono: [
  				'var(--font-sans)',
                    ...fontFamily.mono
                ]
  		},
  		colors: {
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			}
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		boxShadow: {
  			'amber-sm': '0 0 10px -3px hsl(32 100% 65% / 0.3)',
  			'amber': '0 0 20px -5px hsl(32 100% 65% / 0.4)',
  			'amber-lg': '0 0 30px -5px hsl(32 100% 65% / 0.5)',
  			'amber-glow': '0 0 0 1px hsl(32 100% 65% / 0.2), 0 0 30px -5px hsl(32 100% 65% / 0.4)',
  			'terminal-inset': 'inset 0 0 20px -10px hsl(32 100% 65% / 0.2)'
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: 0
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: 0
  				}
  			},
  			gradient: {
  				'0%, 100%': {
  					backgroundPosition: '0% 50%'
  				},
  				'50%': {
  					backgroundPosition: '100% 50%'
  				}
  			},
  			shimmer: {
  				'0%': {
  					backgroundPosition: '-200% 0'
  				},
  				'100%': {
  					backgroundPosition: '200% 0'
  				}
  			},
  			'pulse-glow': {
  				'0%, 100%': {
  					opacity: '0.4',
  					transform: 'scale(1)'
  				},
  				'50%': {
  					opacity: '0.8',
  					transform: 'scale(1.05)'
  				}
  			},
  			float: {
  				'0%, 100%': {
  					transform: 'translateY(0)'
  				},
  				'50%': {
  					transform: 'translateY(-5px)'
  				}
  			},
  			'slide-up-fade': {
  				'0%': {
  					opacity: '0',
  					transform: 'translateY(10px)'
  				},
  				'100%': {
  					opacity: '1',
  					transform: 'translateY(0)'
  				}
  			},
  			'glow-pulse': {
  				'0%, 100%': {
  					boxShadow: '0 0 20px 0 hsl(32 100% 65% / 0.3)'
  				},
  				'50%': {
  					boxShadow: '0 0 40px 5px hsl(32 100% 65% / 0.5)'
  				}
  			},
  			'cursor-blink': {
  				'0%, 50%': {
  					opacity: '1'
  				},
  				'51%, 100%': {
  					opacity: '0'
  				}
  			},
  			'phosphor-in': {
  				'0%': {
  					opacity: '0',
  					filter: 'blur(2px)'
  				},
  				'100%': {
  					opacity: '1',
  					filter: 'blur(0)'
  				}
  			},
  			'text-glow-pulse': {
  				'0%, 100%': {
  					textShadow: '0 0 4px hsl(32 100% 65% / 0.4)'
  				},
  				'50%': {
  					textShadow: '0 0 8px hsl(32 100% 65% / 0.6), 0 0 16px hsl(32 100% 65% / 0.3)'
  				}
  			},
  			'scanline': {
  				'0%': {
  					transform: 'translateY(0)'
  				},
  				'100%': {
  					transform: 'translateY(4px)'
  				}
  			},
  			'fade-in': {
  				'0%': {
  					opacity: '0',
  					transform: 'translateY(10px)'
  				},
  				'100%': {
  					opacity: '1',
  					transform: 'translateY(0)'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out',
  			gradient: 'gradient 3s ease infinite',
  			shimmer: 'shimmer 2s infinite',
  			'pulse-glow': 'pulse-glow 3s ease-in-out infinite',
  			float: 'float 4s ease-in-out infinite',
  			'slide-up-fade': 'slide-up-fade 0.4s ease-out',
  			'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
  			'cursor-blink': 'cursor-blink 1s step-end infinite',
  			'phosphor-in': 'phosphor-in 0.3s ease-out forwards',
  			'text-glow-pulse': 'text-glow-pulse 2s ease-in-out infinite',
  			'scanline': 'scanline 0.1s linear infinite',
  			'fade-in': 'fade-in 0.5s ease-out forwards',
  			'fade-in-delay': 'fade-in 0.5s ease-out 0.1s forwards'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate"), require('@tailwindcss/typography')],
}