import { SevenSegmentDisplayProps } from '@/peripherals/SevenSegmentDisplay.peripheral'
import UnitValue from './components/UnitValue.component'
import styles from './SevenSegmentDisplay.module.css'
import { Handle, Position } from '@xyflow/react';
import { PeripheralSnapshot } from '@/types/peripheral.types';
import { useSimulation } from '@/app/_modules/SimulationProvider.module';


function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

const SevenSegmenteDisplayNode = ({ data }: {
  data: {
    peripheral: PeripheralSnapshot<SevenSegmentDisplayProps>
  }
}) => {
  const { removePeripheral } = useSimulation();
  const sourceAddress = data.peripheral.meta.sourceAddress;
  const peripheral = data.peripheral;

  console.log({
    data: data.peripheral.meta.values
  })

  return <div className={styles.parentCard}>
    {/* Header row */}
    <div className="flex items-center justify-between mb-1.5">
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500" />
        <span className="font-semibold text-[11px] text-zinc-200 truncate max-w-32">
          {peripheral.name}
        </span>
      </div>
      <button
        onClick={() => removePeripheral(peripheral.id)}
        onPointerDownCapture={(e) => e.stopPropagation()}
        className="text-red-400 hover:text-red-500 text-[10px] font-bold px-0.5
            rounded hover:bg-red-950 transition-colors"
        title="Remove"
      >
        ✕
      </button>
    </div>
    <div className='flex gap-1 flex-nowrap'>
      {(data.peripheral.meta.values ?? []).filter(
        (v) => v !== undefined
      ).map((c, index) => <UnitValue key={index} numVal={c as number} />)}
    </div>

    {/* Info bar */}
    <div className="flex items-center gap-3 text-[9px] text-zinc-500 mb-1.5">
      <span>
        src: <span className="font-mono text-zinc-400">{hex(sourceAddress)}</span>
      </span>
    </div>
    {/* Target handle — data bus from CPU */}
    <Handle
      type="target"
      position={Position.Top}
      className="w-2 h-2 bg-blue-400 border-blue-500"
    />
  </div>
}

export default SevenSegmenteDisplayNode
