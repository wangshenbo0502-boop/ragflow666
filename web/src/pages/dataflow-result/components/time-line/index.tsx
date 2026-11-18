import { CustomTimeline, TimelineNode } from '@/components/originui/timeline';
import { useMemo } from 'react';

export interface TimelineDataFlowProps {
  activeId: number | string;
  activeFunc: (id: number | string) => void;
  timelineNodes: TimelineNode[];
}
const TimelineDataFlow = ({
  activeFunc,
  activeId,
  timelineNodes,
}: TimelineDataFlowProps) => {
  const activeStep = useMemo(() => {
    const index = timelineNodes.findIndex((node) => node.id === activeId);
    return index > -1 ? index + 1 : 0;
  }, [activeId, timelineNodes]);
  const handleStepChange = (_step: number, id: string | number) => {
    activeFunc(id);
  };

  return (
    <div className="">
      <div>
        <CustomTimeline
          nodes={timelineNodes}
          activeStep={activeStep}
          onStepChange={handleStepChange}
          orientation="horizontal"
          lineStyle="solid"
          lineColor="rgb(var(--))"
          nodeSize={24}
          activeStyle={{
            nodeSize: 30,
            iconColor: 'rgb(var(--accent-primary))',
            textColor: 'rgb(var(--accent-primary))',
          }}
        />
      </div>
    </div>
  );
};

export default TimelineDataFlow;
