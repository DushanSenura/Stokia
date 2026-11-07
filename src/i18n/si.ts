import type { MessageKey } from "./en";
import { siCore } from "./si-core";

/**
 * Sinhala translations. Partial by design: any missing key falls back to English.
 * NOTE: these should be reviewed by a native Sinhala speaker before launch.
 */
const siBase: Partial<Record<MessageKey, string>> = {
  "brand.tagline": "අද ගණන් කරන්න. ඊයේ දැනගන්න.",

  "nav.dashboard": "උපකරණ පුවරුව",
  "nav.morningStock": "උදෑසන තොගය",
  "nav.products": "නිෂ්පාදන",
  "nav.packaging": "ඇසුරුම්",
  "nav.movements": "තොග චලනයන්",
  "nav.history": "තොග ඉතිහාසය",
  "nav.analytics": "විකුණුම් විශ්ලේෂණ",
  "nav.reports": "මාසික වාර්තා",
  "nav.settings": "සැකසුම්",
  "nav.more": "තවත්",

  "common.signIn": "පිවිසෙන්න",
  "common.signOut": "ඉවත් වන්න",
  "common.getStarted": "ආරම්භ කරන්න",
  "common.exploreFeatures": "විශේෂාංග බලන්න",
  "common.save": "සුරකින්න",
  "common.cancel": "අවලංගු කරන්න",
  "common.close": "වසන්න",
  "common.loading": "පූරණය වෙමින්…",
  "common.retry": "නැවත උත්සාහ කරන්න",
  "common.theme": "තේමාව",
  "common.themeLight": "ලා",
  "common.themeDark": "අඳුරු",
  "common.language": "භාෂාව",
  "common.estimated": "ඇස්තමේන්තු",
  "common.role.owner": "හිමිකරු",
  "common.role.stock_manager": "තොග කළමනාකරු",
  "common.role.viewer": "නරඹන්නා",

  "error.title": "යම් දෙයක් වැරදී ඇත",
  "error.notFoundTitle": "පිටුව සොයාගත නොහැක",

  "auth.login.title": "නැවත සාදරයෙන් පිළිගනිමු",
  "auth.login.subtitle": "ඔබගේ වෙළඳසැලට පිවිසෙන්න.",
  "auth.email": "විද්‍යුත් තැපෑල",
  "auth.password": "මුරපදය",
  "auth.forgot": "මුරපදය අමතකද?",
  "auth.reset.title": "මුරපදය යළි සකසන්න",
  "auth.reset.send": "යළි සැකසීමේ සබැඳිය යවන්න",
  "auth.reset.back": "පිවිසීමට ආපසු",
  "auth.error.invalid": "විද්‍යුත් තැපෑල හෝ මුරපදය වැරදියි.",

  "setup.title": "ඔබගේ වෙළඳසැල සකසන්න",
  "setup.shopName": "වෙළඳසැලේ නම",
  "setup.submit": "වෙළඳසැල සාදන්න",

  "dash.greeting": "ආයුබෝවන්, {name}",
  "dash.enterMorning": "උදෑසන තොගය ඇතුළත් කරන්න",
  "dash.kpi.yesterdaySales": "ඊයේ ඇස්තමේන්තු විකුණුම්",
  "dash.kpi.yesterdayUnits": "ඊයේ විකුණු ඒකක",
  "dash.kpi.pending": "ඉතිරි තොග ගණන් කිරීම්",
  "dash.kpi.activeProducts": "සක්‍රීය නිෂ්පාදන",

  "m.hero.title": "අද ගණන් කරන්න. ඊයේ දැනගන්න.",
  "m.hero.body":
    "දෛනික තොගය කළමනාකරණය කිරීමට, ඊයේ විකුණුවේ කුමක්දැයි තේරුම් ගැනීමට සහ ඔබගේ වෙළඳසැල සංවිධානාත්මකව තබා ගැනීමට සරල ක්‍රමයක්.",
  "m.nav.features": "විශේෂාංග",
  "m.nav.how": "ක්‍රියා කරන ආකාරය",
  "m.nav.calculator": "උත්සාහ කරන්න",
  "m.nav.faq": "ප්‍රශ්න",
  "m.calc.opening": "ඊයේ උදෑසන ගණන",
  "m.calc.received": "දවසේ ලැබුණු තොග",
  "m.calc.damaged": "හානි වූ හෝ ඉවත දැමූ",
  "m.calc.closing": "අද උදෑසන ගණන",
  "m.calc.price": "විකුණුම් මිල (රු.)",
  "m.calc.units": "ඇස්තමේන්තු විකුණුම් ඒකක",
  "m.calc.value": "ඇස්තමේන්තු විකුණුම්",

  "common.saved": "සුරකින ලදී.",
  "common.search": "සොයන්න",
  "common.all": "සියල්ල",
  "common.edit": "සංස්කරණය",
  "common.add": "එක් කරන්න",
  "cat.products.title": "නිෂ්පාදන",
  "cat.products.new": "නව නිෂ්පාදනය",
  "cat.products.categories": "වර්ග",
  "cat.products.searchPlaceholder": "නම, කේතය, SKU හෝ බාර්කෝඩ් සොයන්න",
  "cat.products.active": "සක්‍රීය",
  "cat.products.archived": "සංරක්ෂිත",
  "cat.form.name": "නිෂ්පාදනයේ නම",
  "cat.form.code": "නිෂ්පාදන කේතය",
  "cat.form.create": "නිෂ්පාදනය සාදන්න",
  "cat.variants.title": "ප්‍රභේද (ප්‍රමාණ)",
  "cat.variants.add": "ප්‍රභේදයක් එක් කරන්න",
  "cat.price.selling": "විකුණුම් මිල",
  "cat.price.cost": "මිලදී ගැනීමේ පිරිවැය",
  "cat.categories.title": "වර්ග",
};

/** Base translations overlaid with the core-workflow set (si-core.ts wins where both define a key). */
export const si: Partial<Record<MessageKey, string>> = { ...siBase, ...siCore };
