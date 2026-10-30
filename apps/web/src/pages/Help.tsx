import { Card } from '../components/ui';
import { RulesGuide } from '../components/RulesGuide';

export function Help() {
  return (
    <div className="stack">
      <div>
        <h1 className="large-title">规则说明</h1>
        <p className="subhead" style={{ marginTop: 4 }}>
          这里解释频道线路怎么来的、信誉分是什么意思，以及订阅会导出哪些线路。
        </p>
      </div>
      <Card>
        <RulesGuide scope="public" />
      </Card>
    </div>
  );
}
