export type NavigationAttempt = {
  href: string;
  proceed: () => void;
};

export type NavigationGuard = {
  shouldBlock: () => boolean;
  requestConfirmation: (attempt: NavigationAttempt) => void;
};
