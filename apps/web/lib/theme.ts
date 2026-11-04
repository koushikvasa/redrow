export const THEME_KEY = 'redrow-theme'

export type ThemeChoice = 'system' | 'light' | 'dark'

export const parseThemeChoice = (value: string | null | undefined): ThemeChoice =>
  value === 'light' || value === 'dark' ? value : 'system'

/**
 * Runs in <head> before first paint, so a stored choice never flashes the wrong theme.
 * "system" sets nothing: the stylesheet's media query decides, even with scripts off.
 */
export const themeInitScript = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`
