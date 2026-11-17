import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { z } from 'zod';

import { DynamicForm, FormFieldType, generateSchema } from './dynamic-form';

describe('provider dynamic form validation', () => {
  it('validates nested provider fields without losing sibling schemas', () => {
    const schema = generateSchema([
      {
        name: 'provider.auth.token',
        label: 'Token',
        type: FormFieldType.Password,
        schema: z.string().min(4),
      },
      {
        name: 'provider.auth.region',
        label: 'Region',
        type: FormFieldType.Text,
        schema: z.enum(['local', 'remote']),
      },
    ]);
    expect(
      schema.safeParse({
        provider: { auth: { token: 'secret', region: 'local' } },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        provider: { auth: { token: 'x', region: 'local' } },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        provider: { auth: { token: 'secret', region: 'unknown' } },
      }).success,
    ).toBe(false);
  });

  it('registers hidden-label custom fields and retains nested custom errors', async () => {
    const submit = jest.fn();
    render(
      <DynamicForm.Root
        fields={[
          {
            name: 'provider.token',
            label: 'Hidden token label',
            hideLabel: true,
            type: FormFieldType.Custom,
            schema: z.string(),
            customValidate: (value) =>
              value === 'accepted' || 'Provider token rejected',
            render: (props) => <input aria-label="Token" {...props} />,
          },
        ]}
        defaultValues={{ provider: { token: 'rejected' } }}
        onSubmit={submit}
      >
        <button type="submit">Save</button>
      </DynamicForm.Root>,
    );
    expect(screen.queryByText('Hidden token label')).toBeNull();
    expect(screen.getByLabelText('Token')).toHaveValue('rejected');
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Provider token rejected')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Token'), {
      target: { value: 'accepted' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({ provider: { token: 'accepted' } }),
    );
  });
});
