/*
 *  Copyright 2026 The InfiniFlow Authors. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

import { CompilationTemplateKind } from '@/constants/compilation';
import { TFunction } from 'i18next';
import { capitalize, lowerCase } from 'lodash';

export function formatKindLabel(t: TFunction, kind: string): string {
  const labelKeys: Record<string, string> = {
    [CompilationTemplateKind.Artifacts]: 'llmWiki',
    [CompilationTemplateKind.KnowledgeGraph]: 'graph',
    [CompilationTemplateKind.PageIndex]: 'pageIndex',
    [CompilationTemplateKind.MindMap]: 'structureMindmap',
    [CompilationTemplateKind.Timeline]: 'structureTimeline',
    [CompilationTemplateKind.Tree]: 'tree',
    [CompilationTemplateKind.Empty]: 'custom',
    [CompilationTemplateKind.SessionGraph]: 'sessionGraph',
    [CompilationTemplateKind.SessionEssence]: 'sessionEssence',
  };
  const key = labelKeys[kind];
  return key ? t(`knowledgeCompilation.${key}`) : capitalize(lowerCase(kind));
}
export const isCreateCompilationTemplateGroup = (
  id?: string,
): id is undefined => {
  return !id;
};
