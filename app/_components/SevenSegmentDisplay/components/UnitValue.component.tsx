const on = "bg-red-400";
const off = "bg-red-400/10";

const SevenSegment = ({ segments }: { segments: number[] }) => {
  const [top, topLeft, topRight, middle, bottomLeft, bottomRight, bottom] =
    segments;

  const h = "h-1.5 rounded-full"; // horizontal segment
  const v = "w-1.5 rounded-full"; // vertical segment

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center'
    }} className="gap-1">
      <div className="flex gap-1">
        {/* top-left */}
        <div className={`h-[30px] w-[5px] mt-[5px] ${v} ${topLeft ? on : off}`} />
        {/* top */}
        <div className={`h-[5px] w-[30px] ${h} ${top ? on : off}`} />
        {/* top-right */}
        <div className={`h-[30px] w-[5px] mt-[5px] ${v} ${topRight ? on : off}`} />
      </div>
      {/* middle */}
      <div className={`h-[5px] w-[30px] ${h} ${middle ? on : off}`} />
      <div className="flex gap-1" style={{
        alignItems: 'baseline'
      }}>
        {/* bottom-left */}
        <div>
          <div className={`h-[30px] w-[5px] mb-1 ${v} ${bottomLeft ? on : off}`} />
          <div className={`h-[5px`} />
        </div>
        {/* bottom */}
        <div className={`h-[5px] w-[30px] ${h} ${bottom ? on : off}`} />
        {/* bottom-right */}
        <div>
          <div className={`h-[30px] w-[5px] mb-1 ${v} ${bottomRight ? on : off}`} />
          <div className={`h-[5px`} />
        </div>
      </div>
    </div>
  );
};

const digitSegments: number[][] = [
  [1, 1, 1, 0, 1, 1, 1], // 0
  [0, 0, 1, 0, 0, 1, 0], // 1
  [1, 0, 1, 1, 1, 0, 1], // 2
  [1, 0, 1, 1, 0, 1, 1], // 3
  [0, 1, 1, 1, 0, 1, 0], // 4
  [1, 1, 0, 1, 0, 1, 1], // 5
  [1, 1, 0, 1, 1, 1, 1], // 6
  [1, 0, 1, 0, 0, 1, 0], // 7
  [1, 1, 1, 1, 1, 1, 1], // 8
  [1, 1, 1, 1, 0, 1, 1], // 9
];


const numberToNodeMap: React.ReactNode[] = digitSegments.map((segments, i) => (
  <SevenSegment key={i} segments={segments} />
));

const UnitValue = ({ numVal }: { numVal: number }) => {
  if (numVal > 9 || numVal < 0) {
    throw new Error("Invalid number");
  }
  return <div>{numberToNodeMap[numVal]}</div>;
};

export default UnitValue;
