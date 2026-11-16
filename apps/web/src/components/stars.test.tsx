import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StarInput, Stars } from './stars';

describe('Stars', () => {
  it('renders "Not rated" for null', () => {
    render(<Stars value={null} />);
    expect(screen.getByText('Not rated')).toBeInTheDocument();
  });
  it('exposes an accessible label', () => {
    render(<Stars value={3.5} />);
    expect(screen.getByLabelText('3.5 out of 5 stars')).toBeInTheDocument();
  });
});

describe('StarInput', () => {
  it('selects a rating from 1 to 5', () => {
    const onChange = vi.fn();
    render(<StarInput value={0} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    expect(onChange).toHaveBeenCalledWith(4);
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });
});
