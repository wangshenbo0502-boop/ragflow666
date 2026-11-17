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

import i18n from '@/locales/config';
import storage, { redirectToLogin } from './authorization-util';
import notification from './notification';

export function handleRejectedSession(authorization?: unknown) {
  // A late response from an older session or a shared link cannot clear
  // credentials belonging to the account currently signed into this tab.
  if (
    typeof authorization !== 'string' ||
    !authorization ||
    authorization !== storage.getAuthorization()
  ) {
    return;
  }

  storage.removeAll();
  notification.error({ message: i18n.t('message.401') });
  redirectToLogin();
}
