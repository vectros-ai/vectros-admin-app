import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';

import { TestIntlProvider } from '../../test/intl';
import { NotFoundPage } from './NotFoundPage';

describe('NotFoundPage', () => {
  it('renders the 404 heading, body, and a back-home link to /', () => {
    render(
      <TestIntlProvider>
        <MemoryRouter>
          <NotFoundPage />
        </MemoryRouter>
      </TestIntlProvider>,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: /page not found/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/couldn't find the page/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to home/i })).toHaveAttribute('href', '/');
  });
});
