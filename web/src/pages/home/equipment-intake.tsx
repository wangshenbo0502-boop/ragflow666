import type { EquipmentContext } from './railway-question';

const Fields = [
  { key: 'model', label: '设备型号', placeholder: '如：设备铭牌上的型号' },
  { key: 'alarm', label: '报警代码或提示', placeholder: '按已有记录填写' },
  { key: 'location', label: '发生位置', placeholder: '站点、区段或车厢' },
  { key: 'occurredAt', label: '发生时间', type: 'datetime-local' },
] as const;

export function EquipmentIntake({
  value,
  onChange,
}: {
  value: EquipmentContext;
  onChange: (value: EquipmentContext) => void;
}) {
  const handleField = (event: React.ChangeEvent<HTMLInputElement>) => {
    const key = event.currentTarget.name as keyof EquipmentContext;
    onChange({ ...value, [key]: event.currentTarget.value });
  };

  return (
    <fieldset className="mt-5 min-w-0 border-t border-border-button pt-4">
      <legend className="px-0 pt-4 text-sm font-medium">设备现象记录</legend>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        {Fields.map((field) => (
          <label key={field.key} className="min-w-0 text-xs text-text-secondary">
            {field.label}
            <input
              name={field.key}
              type={'type' in field ? field.type : 'text'}
              placeholder={'placeholder' in field ? field.placeholder : undefined}
              value={value[field.key]}
              onChange={handleField}
              className="mt-2 h-10 w-full min-w-0 rounded-md border border-border-button bg-bg-base px-3 text-sm text-text-primary"
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
