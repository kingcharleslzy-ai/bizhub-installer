export {};

declare global {
  interface Window {
    bizhubLocalDesktop: {
      getSettings(): Promise<Record<string, any>>;
      createBackup(): Promise<{ status: string; path: string }>;
      openBackupFolder(): Promise<{ status: string }>;
      changePassword(input: {
        currentPassword: string;
        newPassword: string;
        remember: boolean;
      }): Promise<{ status: string; remembered: boolean }>;
      switchAccount(): Promise<unknown>;
      forgetAccount(): Promise<unknown>;
    };
  }
}
