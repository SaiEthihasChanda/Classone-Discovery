/**
 * Class One Systems' product line — the data that grounds the AI.
 *
 * Without a real catalog, "which product suits this researcher" has nothing to
 * point at and the model invents plausible-sounding product names.
 *
 * The products come from the website's own catalogue (`data/websiteCatalog.json`,
 * exported from its Firestore by `exportWebsiteCatalog.mjs`) — 86 items across
 * Sensing (PalmSens instruments, OEM modules, application kits), Energy (CorrTest
 * workstations, TOB battery-making equipment), Nano Technology (deposition and
 * coating systems) and Accessories (electrodes and cells). What this file adds
 * is the sales meaning the website does not record: a CRM category, the
 * research areas each product serves, SDK support, and cleaned-up search tags.
 *
 * Kept separate from the seed script so tests and the live smoke test can
 * populate a throwaway database from the same source of truth.
 */
import { repositories } from '../repositories/index.js';
import type { ProductCategory, ProductCreateInput } from '../types/domain.js';
import { slugify } from '../utils/normalize.js';
import websiteCatalog from '../data/websiteCatalog.json' with { type: 'json' };

interface WebsiteProduct {
  slug: string;
  title: string;
  productType?: string;
  group: string;
  groupLabel: string;
  category: string;
  categoryLabel: string;
  tags: string[];
  short?: string;
  desc?: string;
}

const WEBSITE_BASE = 'https://classonesystems.in';

/** The SDKs every PalmSens-firmware instrument can be driven from. */
const PALMSENS_SDKS = ['python', 'matlab', 'labview', 'dotnet', 'methodscript'];

/**
 * Words the website's auto-generated tags are full of that carry no search
 * value — dimensions, stock phrases, HTML leftovers. Anything numeric-led is
 * dropped by pattern; these are the alphabetic ones.
 */
const TAG_STOPLIST = new Set([
  'model', 'customized', 'customizable', 'length', 'current', 'range', 'ranges', 'brass', 'diameter',
  'working', 'material', 'materials', 'acceptable', 'accetable', 'max', 'maximum', 'body', 'rod',
  'available', 'optional', 'control', 'high', 'low', 'feature', 'type', 'product', 'buy', 'durable',
  'usage', 'containing', 'contain', 'set', 'sets', 'via', 'different', 'other', 'name', 'parameter',
  'parameters', 'specification', 'not', 'yes', 'etc', 'about', 'after', 'get', 'same', 'own', 'every',
  'across', 'around', 'built', 'easy', 'fixed', 'full', 'information', 'deliver', 'example', 'results',
  'achievements', 'ease', 'possible', 'typical', 'select', 'compose', 'easily', 'ideal', 'run', 'apps',
  'version', 'versions', 'thickness', 'clipping', 'compliance', 'combined', 'address', 'connect',
  'connection', 'connections', 'input', 'output', 'upper', 'inner', 'outer', 'front-end', 'accurate',
  'suitable', 'equipped', 'enable', 'capability', 'operation', 'mode', 'medium', 'base', 'area',
  'effective', 'process', 'feeding', 'covering', 'square', 'template', 'dual', 'single', 'without',
  'adjustable', 'digital', 'display', 'automatic', 'manual', 'hot', 'cold', 'noise', 'seal', 'oil',
  'tank', 'sample', 'data', 'small', 'applied', 'currents', 'second', 'sense', 'line', 'female',
  'adapter', 'port', 'buttons', 'windows', 'android', 'usb', 'usb-c', 'cable', 'banana', 'jacket',
  'ptfe', 'peek', 'steel', 'stainless', 'plate', 'wire', 'gauze', 'mesh', 'helix', 'clamp', 'holder',
  'specimen', 'die', 'roller', 'sleeve', 'sleeves', 'bracket', 'chip', 'devices', 'device', 'equipment',
  'machine', 'kits', 'kit', 'application', 'applications', 'accessories', 'energy', 'sensing',
  'technology', 'nano', 'analysis', 'measurement', 'measurements', 'measure', 'research', 'instrument',
  'analog', 'calibrated', 'controlled', 'board', 'core', 'module', 'development', 'test', 'testing',
  'temperature', 'power', 'voltage', 'potential', 'pressure', 'speed', 'width', 'dia', 'front',
  'grinding', 'ball', 'planetary', 'mill', 'crimping', 'sealing', 'punching', 'winding', 'pressing',
  'cutting', 'disc', 'discs', 'cutter', 'separator', 'glove', 'vacuum', 'boxes', 'box', 'heating',
  'heat', 'protection', 'method', 'techniques', 'methods', 'hyphenated', 'oxidation', 'flow', 'exchange',
  'assemblies', 'membrane', 'anion', 'dioxide', 'concentrated', 'electrolyte', 'diffusion', 'environment',
  'solution', 'acidic', 'alkaline', 'saturated', 'high-purity', 'high-quality', 'efficient', 'composed',
  'collateral', 'choroid', 'agcl', 'cl-', 'chloride', 'hgo', 'hg2so4', 'salt', 'double', 'bridge',
  'paste', 'polishing', 'alumina', 'powder', 'abrasive', 'contact', 'pad', 'paper', 'meters', 'front',
  'thin', 'films', 'desk', 'sem', 'electronic', 'feedthrough', 'acoustic', 'wave', 'changes',
  'characterization', 'detection', 'interactions', 'amplifier', 'generator', 'plasma', 'dielectrics',
  'evaporation', 'sputtering', 'thermal', 'wearable', 'smart', 'handheld', 'portable', 'bluetooth',
  'app', 'extension', 'micro', 'purposes', 'ground', 'isolation', 'embedded', 'lablink', 'multi-channel',
  'multiplexer', 'channel', 'channels', 'bipot', 'dual-channel', 'editor', 'visual', 'software',
  'capacity', 'curve', 'constant', 'coin', 'cells', 'cell', 'ion', 'lithium', 'sodium', 'solid', 'split',
  'electrode', 'electrodes', 'reference', 'counter', 'glassy', 'carbon', 'platinum', 'gold', 'silver',
  'copper', 'aluminum', 'titanium', 'graphite', 'hydrogen', 'reversible', 'rhe', 'mea', 'palladium',
  'coater', 'coating', 'crystal', 'quartz', 'microbalance', 'deposition', 'analyzer', 'impedance',
  'sensor', 'sensors', 'electrochemical', 'potentiostat', 'galvanostat', 'bipotentiostat', 'eis', 'fra',
  'dc-potential', 'spe', 'oem', 'pico', 'emstat', 'sensit', 'palmsens', 'corrtest', 'nexus', 'pstrace',
  'methodscript', 'arduino', 'analytes', 'autonomously', 'accelerate', 'acquisition', 'battery',
]);

/** Keeps a website tag only if it is a distinctive multi-word phrase or model token. */
function usefulTags(tags: string[]): string[] {
  return tags.filter((t) => {
    const tag = t.toLowerCase().trim();
    if (tag.length < 3) return false;
    if (/^\d/.test(tag)) return false; // 80mm, 10k, 244v, 5pcs
    if (/^[a-z]+-?\d+/.test(tag) && !/^(cs|chi|sa|sw|rt|dsr|dst)\d/.test(tag)) return false;
    if (tag.includes('&#')) return false;
    if (TAG_STOPLIST.has(tag)) return false;
    return true;
  });
}

interface Classification {
  category: ProductCategory;
  applicationAreas: string[];
  sdkSupport: string[];
  /** Extra tags that make the heuristic product mapping work. */
  tags: string[];
}

/** Sales meaning for one website product, from its category and title. */
function classify(p: WebsiteProduct): Classification {
  const t = p.title.toLowerCase();

  switch (p.category) {
    case 'single-channel-electrochemical':
    case 'multi-channel-electrochemical': {
      const multi =
        /multi|mux|rackmount|4x|multi-channel/.test(t) || p.slug.includes('multi');
      return {
        category: multi ? 'multi_channel_workstation' : /nexus/.test(t) ? 'potentiostat_benchtop' : 'potentiostat_portable',
        applicationAreas: multi
          ? ['batteries', 'high-throughput screening', 'electrocatalysis', 'sensor arrays', 'education']
          : ['electroanalysis', 'biosensors', 'electrocatalysis', 'corrosion', 'batteries', 'field measurement'],
        sdkSupport: PALMSENS_SDKS,
        tags: ['palmsens', 'potentiostat', 'galvanostat', 'eis', ...(multi ? ['multichannel'] : ['portable'])],
      };
    }

    case 'electrochemical-development-kit': {
      if (/sensit/.test(t)) {
        return {
          category: 'biosensor_kit',
          applicationAreas: ['biosensors', 'point-of-care', 'wearable sensors', 'screen-printed electrodes', 'diagnostics', 'food safety'],
          sdkSupport: PALMSENS_SDKS,
          tags: ['palmsens', 'sensit', 'biosensor', 'screen-printed-electrodes', 'spe', 'wearable', 'bluetooth'],
        };
      }
      if (/emstat go/.test(t)) {
        return {
          category: 'potentiostat_portable',
          applicationAreas: ['field measurement', 'sensors', 'education', 'electroanalysis'],
          sdkSupport: PALMSENS_SDKS,
          tags: ['palmsens', 'emstat', 'potentiostat', 'handheld'],
        };
      }
      if (/emstat4r/.test(t)) {
        return {
          category: 'potentiostat_benchtop',
          applicationAreas: ['electroanalysis', 'electrocatalysis', 'corrosion', 'batteries'],
          sdkSupport: PALMSENS_SDKS,
          tags: ['palmsens', 'emstat', 'potentiostat', 'eis'],
        };
      }
      return {
        category: 'oem_module',
        applicationAreas: ['oem integration', 'instrument development', 'embedded sensing', 'biosensors', 'point-of-care'],
        sdkSupport: ['methodscript', 'python', 'dotnet'],
        tags: ['palmsens', 'emstat', 'oem', 'embedded', 'module', 'development-kit', 'methodscript'],
      };
    }

    case 'application-kits': {
      if (/spectro/.test(t)) {
        return {
          category: 'spectroelectrochemistry',
          applicationAreas: ['spectroelectrochemistry', 'photoelectrochemistry', 'catalysis', 'materials science', 'conducting polymers'],
          sdkSupport: PALMSENS_SDKS,
          tags: ['palmsens', 'spectroelectrochemistry', 'uv-vis', 'raman', 'in-situ'],
        };
      }
      if (/corrosion/.test(t)) {
        return {
          category: 'application_kit',
          applicationAreas: ['corrosion', 'coatings', 'electrochemical impedance spectroscopy', 'materials science'],
          sdkSupport: PALMSENS_SDKS,
          tags: ['palmsens', 'corrosion', 'eis', 'application-kit'],
        };
      }
      return {
        category: 'application_kit',
        applicationAreas: ['education', 'teaching labs', 'electroanalysis'],
        sdkSupport: PALMSENS_SDKS,
        tags: ['palmsens', 'education', 'teaching', 'application-kit'],
      };
    }

    case 'corrtest': {
      const portable = /portable/.test(t);
      const bipot = /bipotentiostat|2-channel/.test(t);
      const highCurrent = /5a\)|1350/.test(t);
      return {
        category: portable ? 'potentiostat_portable' : bipot ? 'multi_channel_workstation' : 'potentiostat_benchtop',
        applicationAreas: [
          'corrosion',
          'batteries',
          'electrocatalysis',
          'electroanalysis',
          ...(bipot ? ['rotating ring-disk electrode', 'fuel cells'] : []),
          ...(highCurrent ? ['supercapacitors', 'electrolysis', 'electroplating'] : []),
          ...(/eis/.test(t) || /impedance/.test(p.short ?? '') ? ['electrochemical impedance spectroscopy'] : []),
        ],
        sdkSupport: [],
        tags: ['corrtest', 'potentiostat', 'galvanostat', 'workstation', ...(bipot ? ['bipotentiostat', 'rrde'] : []), ...(highCurrent ? ['high-current'] : [])],
      };
    }

    case 'tob':
      return {
        category: 'battery_equipment',
        applicationAreas: [
          'batteries',
          'energy storage',
          'lithium-ion',
          'sodium-ion battery',
          ...(/coin/.test(t) ? ['coin cell'] : []),
          ...(/pouch|winding/.test(t) ? ['pouch cell', 'cell assembly'] : []),
          ...(/solid state|split cell/.test(t) ? ['solid-state battery'] : []),
          ...(/glove/.test(t) ? ['air-sensitive materials', 'inert atmosphere'] : []),
          ...(/ball mill|calender|rolling|press/.test(t) ? ['electrode fabrication', 'materials processing'] : []),
          ...(/temperature/.test(t) ? ['battery testing'] : []),
        ],
        sdkSupport: [],
        tags: ['tob', 'battery', 'cell-fabrication', ...(/coin/.test(t) ? ['coin-cell'] : []), ...(/glove/.test(t) ? ['glove-box'] : [])],
      };

    case 'nano-technology': {
      if (/quartz crystal/.test(t)) {
        return {
          category: 'thin_film_deposition',
          applicationAreas: ['quartz crystal microbalance', 'thin films', 'adsorption', 'biosensors', 'electrodeposition monitoring'],
          sdkSupport: [],
          tags: ['qcm', 'quartz-crystal-microbalance', 'thin-film'],
        };
      }
      if (/laser deposition/.test(t)) {
        return {
          category: 'thin_film_deposition',
          applicationAreas: ['pulsed laser deposition', 'thin films', 'oxide films', 'perovskites', 'semiconductors'],
          sdkSupport: [],
          tags: ['pld', 'pulsed-laser-deposition', 'thin-film'],
        };
      }
      if (/plasma/.test(t)) {
        return {
          category: 'thin_film_deposition',
          applicationAreas: ['plasma processing', 'sputtering', 'surface treatment', 'thin films'],
          sdkSupport: [],
          tags: ['rf-plasma', 'sputtering'],
        };
      }
      return {
        category: 'thin_film_deposition',
        applicationAreas: ['sputter coating', 'thermal evaporation', 'thin films', 'SEM sample preparation', 'nanomaterials'],
        sdkSupport: [],
        tags: ['sputter-coater', 'thermal-evaporation', 'thin-film', 'sem'],
      };
    }

    case 'electrodes':
    case 'glass-cell':
    default: {
      const areas = /reference|calomel|ag\/ag|hg\//.test(t)
        ? ['electroanalysis', 'corrosion', 'electrocatalysis', 'general electrochemistry']
        : /reversible hydrogen|rhe/.test(t)
          ? ['electrocatalysis', 'hydrogen evolution', 'oxygen evolution', 'fuel cells']
          : /mea/.test(t)
            ? ['fuel cells', 'electrolysis', 'membrane electrode assembly']
            : /clamp|holder/.test(t)
              ? ['corrosion', 'coatings', 'materials testing']
              : /polishing/.test(t)
                ? ['electrode preparation', 'electroanalysis']
                : /platinum|gauze|mesh|counter|graphite/.test(t)
                  ? ['electrocatalysis', 'electrolysis', 'electroanalysis']
                  : ['electroanalysis', 'sensors', 'electrocatalysis', 'corrosion'];
      return {
        category: 'electrode',
        applicationAreas: areas,
        sdkSupport: [],
        tags: ['electrode', ...(/reference|calomel|ag\/ag|hg\//.test(t) ? ['reference-electrode'] : []), ...(/working/.test(t) ? ['working-electrode'] : []), ...(/counter/.test(t) ? ['counter-electrode'] : [])],
      };
    }
  }
}

function fromWebsite(p: WebsiteProduct): ProductCreateInput {
  const c = classify(p);
  const modelTokens = p.title
    .toLowerCase()
    .split(/[\s/(),]+/)
    .filter((w) => /^(cs\d|emstat|palmsens|sensit|nexus|multiemstat|multipalmsens|rackmount|pstrace)/.test(w));

  return {
    // Some Firestore ids carry spaces and brackets ("CS350Pro Potentiostat
    // -Galvanostat- EIS(5MHz)"); the CRM key is the slugified form, while the
    // link keeps the original id the website routes on.
    productId: slugify(p.slug),
    name: p.title,
    category: c.category,
    tags: [...new Set([...c.tags, ...modelTokens, ...usefulTags(p.tags)])].slice(0, 30),
    description: (p.short || p.desc || `${p.title} — ${p.groupLabel} / ${p.categoryLabel}`).slice(0, 400),
    applicationAreas: [...new Set(c.applicationAreas)],
    sdkSupport: c.sdkSupport,
    isActive: true,
    sourceUrl: `${WEBSITE_BASE}/product/${encodeURIComponent(p.slug)}`,
  };
}

/**
 * The SDKs are a real part of the offer (the website has a whole developer
 * section for them) but are not catalogue items in Firestore, so they are
 * listed here by hand.
 */
const SOFTWARE: ProductCreateInput[] = [
  {
    productId: 'python-sdk',
    name: 'PalmSens Python SDK (PyPalmSens)',
    category: 'software_sdk',
    tags: ['python', 'pypalmsens', 'sdk', 'automation', 'api', 'palmsens'],
    description: 'Python library for automating electrochemistry experiments on PalmSens instruments — drops into existing analysis workflows.',
    applicationAreas: ['lab automation', 'data analysis', 'high-throughput screening'],
    sdkSupport: ['python'],
    isActive: true,
    sourceUrl: 'https://dev.palmsens.com/python/latest/_attachments/index.html',
  },
  {
    productId: 'matlab-sdk',
    name: 'PalmSens MATLAB SDK',
    category: 'software_sdk',
    tags: ['matlab', 'sdk', 'automation', 'palmsens'],
    description: 'Direct instrument control from MATLAB for groups whose analysis already lives there.',
    applicationAreas: ['lab automation', 'data analysis'],
    sdkSupport: ['matlab'],
    isActive: true,
    sourceUrl: 'https://dev.palmsens.com/matlab/latest/index.html',
  },
  {
    productId: 'labview-sdk',
    name: 'PalmSens LabVIEW SDK',
    category: 'software_sdk',
    tags: ['labview', 'sdk', 'virtual-instruments', 'palmsens'],
    description: 'Native LabVIEW instrument control for wiring measurements into virtual instruments.',
    applicationAreas: ['lab automation', 'test systems', 'instrument integration'],
    sdkSupport: ['labview'],
    isActive: true,
    sourceUrl: 'https://dev.palmsens.com/labview/latest/index.html',
  },
  {
    productId: 'methodscript',
    name: 'MethodSCRIPT',
    category: 'software_sdk',
    tags: ['methodscript', 'scripting', 'embedded', 'palmsens', 'emstat-pico'],
    description: 'The scripting language the latest-generation instruments and modules speak — usable from any language, on any OS, or embedded on an EmStat Pico / EmStat4M.',
    applicationAreas: ['lab automation', 'embedded control', 'instrument development'],
    sdkSupport: ['methodscript'],
    isActive: true,
    sourceUrl: 'https://www.palmsens.com/knowledgebase-article/methodscript/',
  },
];

export const WEBSITE_PRODUCTS = (websiteCatalog as { products: WebsiteProduct[] }).products;

export const CATALOG: ProductCreateInput[] = [...WEBSITE_PRODUCTS.map(fromWebsite), ...SOFTWARE];

/**
 * Inserts or updates every catalog product, and retires anything in the
 * database that is no longer in the catalog (an older seed's placeholder, or a
 * product the website has withdrawn). Re-runnable: upserts by `productId`.
 *
 * Returns the number of products synced.
 */
export async function seedProductCatalog(): Promise<number> {
  for (const product of CATALOG) {
    await repositories.products.upsertByProductId({ ...product, lastSyncedAt: new Date() });
  }
  await repositories.products.deactivateAllExcept(CATALOG.map((p) => p.productId));
  return CATALOG.length;
}
