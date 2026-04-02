import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { signUp } from '@/services/auth';

export default function SignupScreen() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'owner' | 'patient'>('patient');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSignup() {
    if (!displayName || !email || !password) {
      return;
    }
    if (password.length < 6) {
      return;
    }
    setIsLoading(true);
    try {
      await signUp(email, password, displayName, role);
      router.replace('/(app)/appointments');
    } catch (_error: unknown) {
      // Intentionally silent to avoid popup notifications
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.title}>Create account</Text>

        <TextInput
          style={styles.input}
          placeholder="Full name"
          value={displayName}
          onChangeText={setDisplayName}
          autoComplete="name"
        />
        <TextInput
          style={styles.input}
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        <TextInput
          style={styles.input}
          placeholder="Password (min 6 characters)"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <View style={styles.roleRow}>
          {(['owner', 'patient'] as const).map((r) => (
            <TouchableOpacity
              key={r}
              style={[styles.roleButton, role === r && styles.roleButtonActive, r === 'owner' && styles.roleButtonFirst]}
              onPress={() => setRole(r)}
            >
              <Text style={[styles.roleText, role === r && styles.roleTextActive]}>
                {r === 'owner' ? 'Clinic Owner' : 'Patient'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {Platform.OS === 'web' ? (
          <button
            style={{
              backgroundColor: '#3b82f6',
              borderRadius: 8,
              padding: 16,
              alignItems: 'center',
              marginTop: 4,
              border: 'none',
              cursor: 'pointer',
              opacity: isLoading ? 0.6 : 1,
            }}
            onClick={handleSignup}
            disabled={isLoading}
          >
            <Text style={styles.buttonText}>{isLoading ? 'Creating account…' : 'Create account'}</Text>
          </button>
        ) : (
          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={handleSignup}
            disabled={isLoading}
          >
            <Text style={styles.buttonText}>{isLoading ? 'Creating account…' : 'Create account'}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.link}>Already have an account? Sign in</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  inner: { flex: 1, justifyContent: 'center', padding: 24 },
  title: { fontSize: 28, fontWeight: '800', color: '#111827', textAlign: 'center', marginBottom: 20 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    color: '#111827',
  },
  roleRow: { flexDirection: 'row' },
  roleButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  roleButtonFirst: { marginRight: 8 },
  roleButtonActive: { borderColor: '#3b82f6', backgroundColor: '#eff6ff' },
  roleText: { color: '#6b7280', fontWeight: '600' },
  roleTextActive: { color: '#3b82f6' },
  button: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  link: { textAlign: 'center', color: '#3b82f6', marginTop: 8 },
});
