import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AuthCard } from '@vectros-ai/react';
import { BRAND } from '../brand';

describe('AuthCard', () => {
  it('renders the brand productName as non-heading text above the card', () => {
    render(
      <AuthCard brandName="Vectros Admin" title="Sign in">
        <div>form body</div>
      </AuthCard>,
    );
    expect(screen.getByText(BRAND.productName)).toBeInTheDocument();
    // Brand is rendered as a Typography default — NOT a heading. The page
    // title below is the page's single h1.
    expect(
      screen.queryByRole('heading', { name: BRAND.productName }),
    ).not.toBeInTheDocument();
  });

  it('renders title as h1 and body content', () => {
    render(
      <AuthCard brandName="Vectros Admin" title="Sign in" subtitle="Welcome back">
        <div>form body</div>
      </AuthCard>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByText('form body')).toBeInTheDocument();
  });

  it('renders footer when provided', () => {
    render(
      <AuthCard brandName="Vectros Admin" title="Sign in" footer={<a href="/forgot-password">Forgot password?</a>}>
        <div>form body</div>
      </AuthCard>,
    );
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeInTheDocument();
  });

  it('uses a <main> landmark for the auth content', () => {
    render(
      <AuthCard brandName="Vectros Admin" title="Sign in">
        <div>form body</div>
      </AuthCard>,
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
