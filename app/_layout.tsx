import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { initAuthListener, useAuthStore } from '@/store/authStore';
import { LoadingScreen } from '@/components/LoadingScreen';
import '@/services/firebase'; // Initialize Firebase app

export default function RootLayout() {
  const isLoading = useAuthStore((s) => s.isLoading);

  useEffect(() => {
    const unsubscribe = initAuthListener();
    return unsubscribe;
  }, []);

  if (isLoading) return <LoadingScreen />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
