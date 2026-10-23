// A site's cms.config.json. It is bundled into the Worker and the editor, and handed to the WordPress bridge,
// so each layer agrees on the sections that make up the public feed.
const SECTION = /^[a-z][a-z0-9-]{0,39}$/;
const FIELD = /^[a-z_][a-z0-9_]{0,63}$/;
const FIELD_TYPES = ['text', 'textarea', 'url', 'checkboxes'];

function fail(message) {
  throw new Error(`Invalid cms.config.json: ${message}`);
}

export function defineConfig(config) {
  if (!config || typeof config !== 'object') fail('expected an object');
  const { id, name, siteUrl, sections, fieldGroups = [] } = config;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id)) fail('id must be lowercase letters, digits and hyphens');
  if (typeof name !== 'string' || !name.trim() || /[\r\n*]/.test(name)) fail('name is required');
  if (typeof siteUrl !== 'string' || !URL.canParse(siteUrl) || !/^https?:$/.test(new URL(siteUrl).protocol)) fail('siteUrl must be an absolute URL');
  if (!Array.isArray(sections) || !sections.length || sections.length > 20) fail('sections must list 1–20 sections');
  const names = new Set(), categories = new Set();
  const normalisedSections = sections.map(section => {
    const { name: sectionName, category = sectionName, label = sectionName, path = `/${sectionName}/` } = section || {};
    if (typeof sectionName !== 'string' || !SECTION.test(sectionName)) fail(`section name "${sectionName}" must be lowercase letters, digits and hyphens`);
    if (typeof category !== 'string' || !/^[a-z0-9-]{1,200}$/.test(category)) fail(`section ${sectionName} needs a category slug`);
    // A null path keeps the section in the feed without linking to it on the site (testimonials, for example).
    if (path !== null && (typeof path !== 'string' || !/^\/([a-z0-9-]+\/)*$/.test(path))) fail(`section ${sectionName} path must look like /blog/`);
    if (names.has(sectionName) || categories.has(category)) fail(`duplicate section or category: ${sectionName}`);
    names.add(sectionName); categories.add(category);
    return { name: sectionName, category, label: String(label), path };
  });
  const keys = new Set();
  const normalisedGroups = fieldGroups.map(group => {
    if (!group || typeof group.title !== 'string' || !Array.isArray(group.fields)) fail('each field group needs a title and fields');
    return {
      title: group.title,
      fields: group.fields.map(field => {
        const { key, label = key, type = 'text', options = [] } = field || {};
        if (typeof key !== 'string' || !FIELD.test(key) || keys.has(key)) fail(`field key "${key}" must be unique snake_case`);
        if (!FIELD_TYPES.includes(type)) fail(`field ${key} type must be one of ${FIELD_TYPES.join(', ')}`);
        if (type === 'checkboxes' && (!Array.isArray(options) || !options.length || !options.every(option => typeof option === 'string'))) fail(`field ${key} needs options`);
        keys.add(key);
        return { key, label: String(label), type, ...(type === 'checkboxes' ? { options } : {}) };
      })
    };
  });
  return { id, name, siteUrl: siteUrl.replace(/\/$/, ''), sections: normalisedSections, fieldGroups: normalisedGroups };
}

export const sectionNames = config => config.sections.map(section => section.name);
export const fieldKeys = config => config.fieldGroups.flatMap(group => group.fields.map(field => field.key));
export const categoryMap = config => Object.fromEntries(config.sections.map(section => [section.name, section.category]));
