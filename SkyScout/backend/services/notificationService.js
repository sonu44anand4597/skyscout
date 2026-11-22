import { dispatchNotification, InAppNotificationProvider } from "./notificationProviders.js";
import { logServiceError } from './safeLogging.js';

const providers = [{ provider: new InAppNotificationProvider(), required: true }];

export function registerNotificationProvider(provider, { required = false } = {}) {
  if (typeof provider?.send !== "function") throw new TypeError("Notification providers must implement send().");
  const registration = { provider, required };
  providers.push(registration);
  return () => {
    const index = providers.indexOf(registration);
    if (index >= 0) providers.splice(index, 1);
  };
}

export async function createNotification(notification) {
  await dispatchNotification(notification, providers, (error) => {
    logServiceError('optional_notification_delivery_failed', error);
  });
}
