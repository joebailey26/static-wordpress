import stylesheet from '../wordpress/themes/headless/style.css';
import functions from '../wordpress/themes/headless/functions.php';
import index from '../wordpress/themes/headless/index.php';

// Named after the site so snapshots made before the theme was shared keep their active theme.
export const headlessTheme = config => `${config.id}-headless`;
export const headlessThemeFiles = config => ({
  'style.css': stylesheet.replaceAll('%SITE_NAME%', config.name).replaceAll('%SITE_ID%', config.id),
  'functions.php': functions,
  'index.php': index
});
export const isRetiredThemeFile = path => path.startsWith('themes/twentytwentyfive/');
