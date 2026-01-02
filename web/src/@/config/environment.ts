export const getEnvironment = () => {
  // Check various environment indicators
  if (process.env.NEXT_PUBLIC_ENVIRONMENT) {
    return process.env.NEXT_PUBLIC_ENVIRONMENT;
  }
  
  if (process.env.NEXT_PUBLIC_PR_NUMBER) {
    return 'preview';
  }
  
  if (process.env.NODE_ENV === 'production') {
    return 'production';
  }
  
  if (process.env.NODE_ENV === 'test') {
    return 'test';
  }
  
  return 'development';
};

export const isPreview = () => getEnvironment() === 'preview';
export const isProduction = () => getEnvironment() === 'production';
export const isDevelopment = () => getEnvironment() === 'development';
export const isTest = () => getEnvironment() === 'test';

export const getPRNumber = () => {
  return process.env.NEXT_PUBLIC_PR_NUMBER ?? null;
};

// Aliases for compatibility
export const isPreviewDeployment = isPreview;
export const getPreviewPRNumber = getPRNumber;

// Config object for feature flags
export const config = {
  isDevelopment: isDevelopment(),
  isProduction: isProduction(),
  isPreview: isPreview(),
  features: {
    showEnvironmentBanner: isPreview() || isDevelopment()
  },
  api: {
    url: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:9091'
  }
};