import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { readParentPushData } from '@hon/contracts/parent-push';
import type { PhonePush } from './push';

/**
 * expo-notifications for the HON Family app. Announcements show as a normal banner even while the app is open. The
 * token is Expo's for this app's EAS project; Android needs the project's Firebase key (FCM V1) uploaded to EAS first.
 */
export function createExpoPhonePush(projectId: string): PhonePush | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
  let channel: Promise<unknown> | undefined;
  return {
    platform: Platform.OS,
    async token(ask) {
      if (Platform.OS === 'android') channel ??= Notifications.setNotificationChannelAsync('default', { name: 'School announcements', importance: Notifications.AndroidImportance.DEFAULT });
      await channel;
      let permission = await Notifications.getPermissionsAsync();
      if (!permission.granted && ask && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) return null;
      return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    },
    onOpenAnnouncement(listener) {
      const open = (response: Notifications.NotificationResponse | null) => {
        if (response && readParentPushData(response.notification.request.content.data)) listener();
      };
      // A tap that opened the app from closed, then every tap while it runs.
      void Notifications.getLastNotificationResponseAsync().then(open).catch(() => undefined);
      const subscription = Notifications.addNotificationResponseReceivedListener(open);
      return () => subscription.remove();
    },
  };
}
