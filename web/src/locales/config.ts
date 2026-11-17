import { LanguageAbbreviation } from '@/constants/common';
import storage from '@/utils/authorization-util';
import dayjs from 'dayjs';
import i18n from 'i18next';
import { upperFirst } from 'lodash';
import { initReactI18next } from 'react-i18next';
import translation_en from './en';
import translation_zh from './zh';
import translation_zh_traditional from './zh-traditional';

const supportedLanguageCodes: Intl.UnicodeBCP47LocaleIdentifier[] = [
  LanguageAbbreviation.Zh,
];

export const supportedLanguages = supportedLanguageCodes.map((code) => {
  const locale = new Intl.Locale(code);

  return {
    code,
    locale,
    displayName: upperFirst(
      new Intl.DisplayNames(locale, { type: 'language' }).of(code)!,
    ),
  };
});

export const DEFAULT_LANGUAGE_CODE = LanguageAbbreviation.Zh;

// Enterprise customization overlays: the enterprise repository carries real
// implementations of these same-path files (`web/src/ee/locales/*-private.ts`);
// upstream ships them as empty objects so shared imports resolve in both
// trees. Enterprise content must live only in the ee/ files, never here.
import merge from 'lodash/merge';
import translation_en_private from '@/ee/locales/en-private';
import translation_zh_private from '@/ee/locales/zh-private';
import translation_zh_traditional_private from '@/ee/locales/zh-traditional-private';

const resources = {
  [LanguageAbbreviation.En]: merge(translation_en, translation_en_private),
  [LanguageAbbreviation.Zh]: merge(translation_zh, translation_zh_private),
  [LanguageAbbreviation.ZhTraditional]: merge(
    translation_zh_traditional,
    translation_zh_traditional_private,
  ),
};

const updateDocumentLocale = (lng: string) => {
  document.documentElement.lang = lng;
  document.documentElement.dir = 'ltr';
  dayjs.locale(lng === LanguageAbbreviation.Zh ? 'zh-cn' : lng);
};

i18n.use(initReactI18next).init({
  supportedLngs: supportedLanguageCodes,
  lng: DEFAULT_LANGUAGE_CODE,
  resources,
  fallbackLng: DEFAULT_LANGUAGE_CODE,
  interpolation: {
    escapeValue: false,
  },
});

export const changeLanguageAsync = async (
  _lng: string,
  options: { persist?: boolean } = {},
): Promise<void> => {
  const { persist = true } = options;
  const normalizedLng = DEFAULT_LANGUAGE_CODE;

  if (persist) {
    storage.setLanguage(normalizedLng);
  }

  updateDocumentLocale(normalizedLng);

  await i18n.changeLanguage(normalizedLng);
};

export const initLanguage = async (): Promise<void> => {
  await changeLanguageAsync(DEFAULT_LANGUAGE_CODE);
};

export default i18n;
