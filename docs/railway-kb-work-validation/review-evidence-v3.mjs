import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save, table } from './run.mjs';

const inputsPath = '00-control/acceptance-v3-context-inputs.json';
const answersPath = '00-control/acceptance-v3-context-answers.json';
const reportPath = '05-review/evidence-semantic-review-v3.json';
const inputsBytes = await readFile(path.join(root, inputsPath));
const answersBytes = await readFile(path.join(root, answersPath));
const inputs = JSON.parse(inputsBytes);
const answers = JSON.parse(answersBytes);
const docs = await load('00-control/document-register.json');
const check = process.argv.includes('--check');
const judgments = [
  ['GW01', 'PASS', ['DOC0006-K15', 'DOC0008-K05'],
    '验收与评估并非同一环节；初步验收、运营安全评估、初期运营、正式验收和正式运营的依赖关系与存档条文一致，保留效力待核验提示。必要条款在回答上下文第10条，不得以回答正确覆盖Top5漏召回。',
    '存档文本语义无待修正项；检索漏召回另行处理，版本效力仍待核验。'],
  ['GW02', 'FAIL', ['DOC0010-K03', 'DOC0010-K06', 'DOC0010-K09', 'DOC0010-K10', 'DOC0010-K11', 'DOC0010-K12'],
    '第九至十一条的项目和责任主体转述基本相符；但末段声称知识库未单独列出对象概括条款，与同一回答上下文第三条直接定义基础设施对象相矛盾。不能把检索靠后或未采用的证据误报为资料缺失。',
    '优先引用第三条的对象与定义，再按需列检测项目；删除不存在对象概括条款的断言，保留版本核验边界。'],
  ['GW03', 'PASS', ['DOC0006-K39', 'DOC0006-K37'],
    '上下游各500米、安全技术评价、征求铁路运输企业意见、确认安全或者采取措施后方可批准及依法日常养护疏浚例外均保留。补充的1000米事项明确是另一类限制，没有把两类距离合并。',
    '存档文本语义无待修正项；现行效力尚未另行核验，不能据本项直接给最终法规验收。'],
  ['GW04', 'PARTIAL', ['DOC0006-K14', 'DOC0007-K17', 'DOC0009-K36'],
    '禁止违规压缩、合理确定调整、论证和合同相对方同意均有对应原文；正文引用保留了根据需要调整费用和安全措施，小结却改成无该限定的须相应调整，存在摘要条件弱化。勘察设计合同工期条款须保持其对象范围。',
    '小结补回根据需要的限定；不要将勘察设计合同条款泛化为所有合同，继续保留效力提示。'],
  ['GW05', 'PASS', ['DOC0006-K30', 'DOC0024-K22', 'DOC0006-K89'],
    '同意加安全协议、相关标准规范、铁路运输企业派员监督均可定位；高速铁路及纳入邻近营业线施工计划的适用条件保留。补充罚则的可以及10万元、3万元上限与存档条文一致，并有现行版本待核验提示。',
    '存档文本语义无待修正项；不将本项等同于外部版本效力通过。'],
  ['GW06', 'PARTIAL', ['DOC0006-K55', 'DOC0024-K25', 'DOC0007-K35'],
    '运营巡查的立即处理、不能处理时报告和记录留存都有依据；但把条例第五十五条标题写成仅普速，原条没有该限制。补充施工检查报告时未保留重大隐患及报告后未及时处理等分级前提，容易将三个报告对象读成一般并列义务。',
    '删除仅普速的归类；无关施工条款可删，如保留须完整区分一般问题、重大隐患和报告后未及时处理。'],
  ['GW07', 'PASS', ['DOC0006-K38', 'DOC0006-K91'],
    '600米归入500米以上档，上游500米下游3000米及依法划定更大范围优先均准确。补充处罚没有虚构金额，定位第九十一条第四项可支持。',
    '存档文本语义无待修正项；效力状态保持单独待核验。'],
  ['GW08', 'PASS', ['DOC0006-K27'],
    '市区10米、其他地区20米和坡脚、坡顶或桥梁外侧起算均保留；必要时另行划定没有被解释成建设单位可自行决定。未把其他地区混写为城市郊区。',
    '存档文本语义无待修正项；具体适用和版本效力未由本项认定。'],
  ['H01', 'PARTIAL', ['DOC0006-K38', 'DOC0024-K19', 'DOC0006-K27'],
    '恰为500米的分档、距离及不得用较小范围替代依法划定较大范围正确。附带高速铁路定义遗漏含预留，缩窄原定义；该补充不是本题必要内容。',
    '删除非必要高速铁路定义，或原样保留含预留等全部边界。'],
  ['XH01', 'PARTIAL', ['DOC0011-K33', 'DOC0011-K06', 'DOC0011-K05', 'DOC0011-K12',
    'DOC0006-K74', 'DOC0011-K32', 'DOC0011-K04', 'DOC0011-K35', 'DOC0011-K14'],
    '许可、干扰排查报告、机制和台站布局均可定位。但特别保护的首条概括遗漏第三十三条依法使用的前提；后文另一处出现依法使用不能自动补齐该独立结论的限定。',
    '将特别保护准确写为国家对依法使用的相应频率予以特别保护，其余保留来源和效力边界。'],
  ['XH02', 'PARTIAL', ['DOC0012-K04', 'DOC0012-K11', 'DOC0012-K13', 'DOC0012-K09',
    'DOC0012-K15', 'DOC0012-K14', 'DOC0012-K18', 'DOC0012-K20'],
    '主体责任、负责人、三级保护、供应链条件和重大事件报告主体基本准确。主动展开第十五条境内存储和出境评估时遗漏法律、行政法规另有规定的依照其规定执行这一例外。',
    '补回第十五条末句例外，不将一般出境评估表述为没有法定例外的绝对规则。'],
  ['XH03', 'PASS', ['DOC0006-K52', 'DOC0024-K13'],
    '地下电缆两侧各1米、过河光电缆两侧各100米及地面上方禁行为与原文一致。此前怀疑补充引用第十三条不相关，经回查该条末款确有同意并签订安全协议规定，此线索不成立，不据此报错。',
    '存档文本语义无待修正项；保留核验推翻旧线索的证据，不将线索当作既成缺陷。'],
  ['XH04', 'PASS', ['DOC0011-K15', 'DOC0011-K17', 'DOC0011-K18', 'DOC0011-K16',
    'DOC0011-K21', 'DOC0011-K22', 'DOC0011-K37', 'DOC0011-K40'],
    '未称全部免审批；保留无线电条例第二十七条第一至第三项例外，未自行补造例外内容。制式和非制式许可分工、受理起30个工作日、变更注销及境外台站条件均有对应存档条文。',
    '存档文本语义无待修正项；不替代被转引条例或当前效力核验。'],
  ['XH05', 'PARTIAL', ['DOC0006-K74', 'DOC0011-K32', 'DOC0011-K34'],
    '排查自查、内因及投诉条件和严重干扰的部门分工有依据。但第七十四条原文是立即采取排查措施并报告；回答把立即仅标在排查条目，报告另列，未明确不能等自查无效后才履行报告义务。',
    '完整并列表达立即采取排查措施并报告，区分法定报告与自查仍不能消除时可以投诉。'],
  ['XH06', 'PASS', ['DOC0012-K20'],
    '重大事件或威胁、按规定报告两部门及立即启动本单位预案准确；特别重大情形上报主体明确为国家铁路局，没有转嫁给运营者。',
    '存档文本语义无待修正项；版本效力另行核验。'],
  ['XH07', 'PASS', ['DOC0006-K52'],
    '80米落在过河光电缆两侧各100米禁抛锚范围内的判断与存档条文相符，未把地下电缆1米范围与过河100米混淆，并保留效力提示。',
    '存档文本语义无待修正项；不构成具体现场安全批准。'],
  ['XH08', 'FAIL', ['DOC0014-K30', 'DOC0014-K31', 'DOC0014-K29', 'DOC0014-K49'],
    '正确提示设备类别不等于型号获证，却又两次称具体型号取证状态须逐行回设备目录原表核对，给出该目录并不具有的证书状态核验能力，结论自相矛盾。设备清单来自PDF附表，本轮尚未重新逐格视觉核验。',
    '明确目录只核设备范围与标准，不能证明具体型号许可状态；证书状态须有独立许可证据。设备细项留待PDF核验，不凭摘要通过。'],
  ['H02', 'PARTIAL', ['DOC0012-K16', 'DOC0012-K10', 'DOC0012-K17', 'DOC0012-K13'],
    '每年至少一次网络检测和风险评估、整改报送以及建设阶段三同步正确。正文保留法定要求使用商用密码前提，小结却泛化成涉及商用密码就须每年评估，扩大第十七条适用对象。',
    '小结也保留法律、行政法规和国家有关规定要求使用商用密码保护的前提。'],
  ['H03', 'PARTIAL', ['DOC0014-K45'],
    '附件4判定的五个并列条件及12项总数计算准确。回答追加“知识库还特别说明”不得相加及任一条件不满足即不合格，须核验是否确为整理正文而不是来源原文；该解释与所列并列门槛一致，但不能作为附表原文引语。',
    '将计算结论标为根据附件4条件推导，不表述为附件另有该段明文；附件表格仍需视觉复核。'],
  ['H04', 'PARTIAL', ['DOC0017-K13', 'DOC0018-K15'],
    '分别呈现2022考试文件普遍测试表述和2024许可办法Z1/Z2例外，未隐藏冲突。对现行资格问题直接断定2024办法为准，未在引用证据中说明旧文件与新规则的规范衔接关系，超出原条文本身可证明范围。',
    '说明两份文件规定对象和文本差异；未经效力衔接依据，不替用户裁定废止、优先或适用结论。'],
  ['H05', 'PASS', ['DOC0003-K25'],
    '离开安检区域后返回须重新检查，与未离开区域的中转换乘旅客企业可以不再检查的差异及裁量语气均保留，效力待核验提示明确。',
    '存档文本语义无待修正项；版本效力另行核验。'],
  ['GD01', 'PARTIAL', ['DOC0014-K30', 'DOC0014-K31'],
    '回答引用的K30/K31只说明信号与通信目录摘要，不含本题所需的牵引供电设备类别行；必要证据DOC0014-K32未出现在本题实际引用中，故这是已证实的检索缺证，不能据此判定回答声称整个知识库没有设备清单。回答建议查原PDF，但该附件尚未逐格视觉核验。',
    '在检索命中K32及核验附件前，不对牵引供电条目作肯定或否定断言；分别报告证据漏召回和PDF待审。'],
  ['GD02', 'PASS', ['DOC0006-K75'],
    '电力企业持续供应与供电质量、铁路运输企业用电安全和电源配置、特殊情况下双方按各自职责抢修均准确。生产许可补充明确与本题主体责任不同，没有混同。',
    '存档文本语义无待修正项；效力待核验。'],
  ['GD03', 'PASS', ['DOC0006-K53', 'DOC0024-K24'],
    '导线两侧各500米升放飘浮物、杆塔拉线周围20米内取土打桩钻探等限制准确；将高速铁路相关要求区分呈现，未把无人机规则写成禁飞。',
    '存档文本语义无待修正项；涉及现场行为时仍须核验适用条件。'],
  ['GD04', 'PARTIAL', ['DOC0015-K08', 'DOC0015-K11', 'DOC0015-K12', 'DOC0015-K17'],
    '回答引用的许可决定、有效期、变化后重新申请等片段可定位，但没有引用适用范围的直接条款；知识库内其他资料是否含直接的未许可生产责任也需回查。不能仅凭回答引用列表确认其“未检索到”断言已覆盖全库。',
    '补入直接适用范围证据；回查法律责任章节后再回答未获许可能否生产，避免无证据推断。'],
  ['GD05', 'PASS', ['DOC0006-K75'],
    '双方持续供电、用电管理、电源配置以及按各自职责及时抢修的分工准确；关联事故行车条款明确标为不同场景。',
    '存档文本语义无待修正项；效力待核验。'],
  ['GD06', 'PASS', ['DOC0015-K06', 'DOC0015-K07', 'DOC0015-K08', 'DOC0014-K08', 'DOC0014-K09'],
    '当场更正、当场或5个工作日内一次告知全部补正内容、逾期视为受理、提交全部补正后受理及出具凭证均符合所列条文。后续现场核实人数为至少2名且仅在实施现场核实时适用，回答已保留条件。',
    '存档文本语义无待修正项；实施细则与办法效力关系仍需单独核验。'],
  ['GD07', 'PARTIAL', ['DOC0006-K53', 'DOC0024-K24', 'DOC0024-K23'],
    '400米小于500米、15米小于20米的条件判断以及限制事项准确。将第五十三条具体行为范围直接概括为一般禁止行为，未先声明其适用对象和电力线路类别；添加无人机等非本题内容造成焦点稀释。',
    '保留阈值判断，补全第五十三条适用对象，删去非必要无人机及无关扩展。'],
  ['GD08', 'PARTIAL', ['DOC0015-K09', 'DOC0015-K11', 'DOC0014-K16', 'DOC0014-K19'],
    '5年有效期、届满60个工作日前申请及受理后20个工作日并可延长10个工作日的时限区分准确。明确检验检测和专家评审时间不计入期限，但本轮须确认援引条款中是否还包括现场核实等时间；不能截取不完整的停表范围。',
    '逐字核对第九条完整停表事项并完整列出；若不是本题必需，可缩短时限补充，避免不完整罗列。'],
  ['CL01', 'PARTIAL', ['DOC0022-K02', 'DOC0022-K03', 'DOC0022-K07', 'DOC0022-K08',
    'DOC0022-K09', 'DOC0022-K11', 'DOC0022-K13'],
    '设计型号合格证、制造许可证、维修许可证、进口许可证的环节条件基本按第三条区分。回答把初始总括描述为设计、制造、维修或者进口新型车辆均分别领证，可能扩大“维修”等许可证的适用触发条件；后续分项虽有修正，开头仍应保持一致。',
    '删除无条件的总括句，仅按第三条各类具体适用情形分别作答，并保留目录范围边界。'],
  ['CL03', 'PARTIAL', ['DOC0001-K19', 'DOC0001-K33'],
    '安全性、可靠性、可维修性评估及符合标准后方可实施的要求与第十九条对应。主动补充罚款金额和责任主体时须核对第三十三条完整触发条件，不可只凭处罚数额概括。',
    '优先回答所问评估要求；若保留处罚，逐项列全违法构成、前置责令改正/停止使用条件及责任主体。'],
  ['CL04', 'PARTIAL', ['DOC0001-K14', 'DOC0001-K34'],
    '未鉴定、鉴定达到报废条件、应淘汰设备不得继续使用的边界按第十四条区分。回答主动列罚款时应完整核对第三十四条中责令改正、立即停止、逾期未改正等不同触发条件，避免将多档责任压成一个概括。',
    '收窄回答至设备禁用条件，或逐字核对各处罚档次和触发条件。'],
  ['CL05', 'PASS', ['DOC0022-K15'],
    '当场更正、当场或5个工作日一次告知、逾期视为受理、补正后受理及书面凭证条件均准确，未遗漏问题要求的关键期限和例外。',
    '存档文本语义无待修正项；2013文件当前效力须另行核验。'],
  ['CL06', 'PARTIAL', ['DOC0023-K04', 'DOC0023-K08', 'DOC0023-K09', 'DOC0023-K11',
    'DOC0023-K14', 'DOC0023-K18', 'DOC0023-K22', 'DOC0023-K24', 'DOC0023-K31'],
    '生产者调查、通知、停止活动、召回消缺和使用方配合的主要流程有来源。将条例第二十六条概括为制造者召回义务时未在该句并列保留铁路运输企业配合义务；罚则金额百分比范围需核原条单位、基数和分档条件，当前概括可能掩盖条件。',
    '把条例义务主体和召回办法流程分开表达；法律责任按完整条件、基数和档次复核后再保留。'],
  ['CL07', 'PARTIAL', ['DOC0001-K15'],
    '使用条件、维修周期标准、方式、项目、作业标准、质量检验项目及标准的清单与第十五条一致。额外对论证评审、及时修订的总结需分别对应同条具体原文限定，避免把分条要求改成所有技术规则都必须经过同一固定环节。',
    '将最低项目清单与其他技术文件要求分开，按原文保留对象、条件和修订要求。'],
  ['CL08', 'PARTIAL', ['DOC0001-K10'],
    '设计寿命、维修周期、维修范围、技术要求与第十条相符；“基本技术资料还包括但不限于”是扩大性表述，需核对原文究竟是开放列举还是明确列举，不能自行加入但不限于。',
    '按原文完整列举基本技术资料范围，不添加原文没有的开放性措辞。'],
  ['YS01', 'PASS', ['DOC0002-K03', 'DOC0002-K17'],
    '实名购买的购售票主体、有效证件及身份和购票信息记录，与实名查验的一致性核对及乘车信息记录区分准确。补充第十七条的证件和拒绝进站乘车条件有存档正文支持。',
    '存档文本语义无待修正项；文号、来源版本及现行效力仍须单独核验。'],
  ['YS02', 'PASS', ['DOC0003-K03'],
    '安检实施地点、旅客及随身携带和托运物品的对象范围、国家铁路局会同公安部公布目录的依据，均与第三条一致；保留了后续修订待核验提示。',
    '存档文本语义无待修正项；不把条款转述通过当作目录全文或现行效力核验完成。'],
  ['YS03', 'PASS', ['DOC0003-K25'],
    '未离开已安检区域、中转换乘及铁路运输企业可以不再安检的条件和裁量语气完整；与临时离开后返回应重新检查的情形明确区分。',
    '存档文本语义无待修正项；具体适用版本仍待核验。'],
  ['YS04', 'PASS', ['DOC0004-K12', 'DOC0004-K13'],
    '实名制下6周岁、14周岁的含与不含边界、一名免费儿童、不占席位、超额人数和单独占席购票要求准确。随行例外、车次席别到站和提前告知及实名证件要求均有对应条款，没有混入非实名制身高口径。',
    '存档文本语义无待修正项；原件文号与现行效力另行核验。'],
  ['YS05', 'PASS', ['DOC0003-K18', 'DOC0003-K20', 'DOC0003-K23'],
    '无法通过设备检查的物品适用条件、视频监控覆盖场所、一般由旅客出示及必要时人员检查且旅客在场、移至适当场合的条件均保留；婴儿车轮椅要求也保留不能通过安全检查仪的前提。',
    '存档文本语义无待修正项；版本效力仍为单独验收项。'],
  ['YS06', 'PASS', ['DOC0005-K16'],
    '第十六条七项报告内容逐项对应，区间定位单位、列车和人员车辆信息、初步原因、措施控制及救援请求未漏项；出现新情况应及时补报的要求准确。',
    '存档文本语义无待修正项；不据此确认2012修订文本截至核验日仍为最新适用版本。'],
  ['YS07', 'PASS', ['DOC0003-K33'],
    '免费保管期限保留一般不超过3天、旅客提出交站保管及另有约定从约定的条件；自弃或逾期处理准确区分有国家规定与没有国家规定两种情形。',
    '存档文本语义无待修正项；版本效力另行核验。'],
  ['YS08', 'PASS', ['DOC0005-K13', 'DOC0005-K12', 'DOC0005-K11'],
    '以上含本数、以下不含本数限定在事故等级章节；3人及其他死亡重伤损失示例对应第十一、十二条，未将该边界泛化成所有法规的一般规则。重复携带的边界依赖是整理标记，不改变原条。',
    '存档文本语义无待修正项；不得将边界示例解释为具体事故不考虑其他升级条件的最终定级。'],
  ['YS10', 'PASS', ['DOC0005-K33', 'DOC0005-K35', 'DOC0005-K36'],
    '明确隔离已标记删除的第三十三条历史金额，没有复活旧限额；第三十五条交叉引用不能恢复旧款属于整理边界说明，回答已标为知识库提示。争议处理三种途径与第三十六条一致。',
    '存档文本语义无待修正项；现行赔偿责任与金额仍须正式适用法律核验，不能以本题代替。'],
  ['C01', 'PASS', ['DOC0006-K30', 'DOC0006-K52', 'DOC0013-K48', 'DOC0013-K50', 'DOC0006-K50'],
    '正文分别保留安全保护区内所列行为的同意和协议、营业线隐蔽设施位置提供与共同探查责任，以及电缆地面上方和两侧各1米等不同禁行为。警示标志和防挖断措施均可定位；必要条款出现在回答上下文不代表Top5完整命中。',
    '存档文本语义无待修正项；现场适用必须保留正文各自范围，不得只据简写小结批准施工。'],
  ['C02', 'PARTIAL', ['DOC0004-K42', 'DOC0004-K43', 'DOC0004-K31', 'DOC0004-K30'],
    '旅客安置、退改票和差额及免退票费准确；但供电恢复的主体分工没有回答，必要证据DOC0006-K75未进入上下文。不能由本次检索结果推断整个知识库没有针对供电异常的规定；本题也未要求编造抢修技术时限。',
    '补召回K75后说明电力企业和铁路运输企业按各自职责及时抢修、尽快恢复供电；与技术时限资料缺口分开记录。'],
  ['C03', 'PARTIAL', ['DOC0010-K03', 'DOC0010-K10', 'DOC0001-K36'],
    '基础设施对象、状态检测定义及信号通信检测项目准确，但样车运用考核的必要证据DOC0022-K06未进入上下文。不能把未命中该条扩大为库中没有相关车辆考核资料；两份独立规定也不能证明一切具体考核材料绝不共享。',
    '补召回K06，逐项区分样车考核条件和基础设施检测对象；表述为现有证据不支持无条件互相替代，不虚构两制度间的禁止条款。'],
  ['C04', 'FAIL', ['DOC0006-K15', 'DOC0008-K05', 'DOC0022-K03'],
    '工程验收阶段关系可定位，但把问题中的设备生产许可改成铁路机车车辆制造许可，漏掉铁路运输基础设备生产企业审批这一必要制度和DOC0015-K03，核心比较对象错误。引用确有车辆条款不等于它能替代题设设备许可范围。',
    '重新召回DOC0015-K03及其第二条依赖，比较工程验收与铁路运输基础设备生产许可的对象；车辆制造许可仅作不同制度辨析。'],
  ['C05', 'FAIL', ['DOC0003-K09', 'DOC0003-K41', 'DOC0001-K36', 'DOC0001-K20'],
    '安检设备的经常维护、定期检测及禁用条件有依据；但回答将安检办法未覆盖车载制动扩展为整个知识库未收录相关设备维护内容。实际上下文已含铁路设备及机车车辆范围和设备维修规范条款，必要DOC0001-K15另有漏召回，不能一概否定全库。',
    '限定结论为不能从旅客安检办法直接推出车辆制动维护要求；补召回设备技术规则的一般要求，同时保留具体制动型号检修参数尚未提供的边界。'],
  ['C06', 'PARTIAL', ['DOC0011-K04', 'DOC0011-K32', 'DOC0011-K34', 'DOC0011-K35', 'DOC0011-K28', 'DOC0011-K31'],
    '无线电保护工作机制、投诉处理、严重干扰和联合执法的主体转述基本相符，但未回答桥梁施工这一半。DOC0006-K30未召回，且题目本身没有明示施工是否在安全保护区；不应把未命中当作全库没有协调监督规定。',
    '补召回K30并先限定安全保护区内所列行为，再回答运输企业同意和现场监督；区外施工或其他行为需补适用证据，不套用无线电条款替代。'],
  ['C07', 'FAIL', ['DOC0001-K12', 'DOC0005-K24', 'DOC0005-K14', 'DOC0007-K63', 'DOC0007-K64', 'DOC0021-K36'],
    '上下文中DOC0001-K12明确规定质量保证期内许可产品质量安全相关事故的季度报告，回答却未采用并以其他三类事故报告替代。运输企业质量信息统计及及时报告所需K21也未召回，漏答了题设的信息报告主体和节奏；泛引其他事故制度不能补齐。',
    '先回答设备生产企业K12和运输企业K21各自对象、季度及及时报告条件，再有条件区分铁路交通事故现场保护K24；不把建设或危货事故时限拼成车辆质量事故通则。'],
  ['C08', 'PASS', ['DOC0006-K52', 'DOC0006-K53'],
    '地下光电缆两侧各1米与电气化铁路电力线路杆塔、拉线周围20米的取土限制区分准确；过河电缆另列100米且说明其原文针对挖砂等作业。未把20米写成一般电缆范围。',
    '存档文本语义无待修正项；起算对象不同，不能据宽窄比较替代现场边界认定。'],
  ['C09', 'PARTIAL', ['DOC0005-K19', 'DOC0004-K43'],
    '事故中断后的立即抢修与必要时调径路，以及第三十一条退改票、差额和免退票费内容准确；但将整理者在第四十三条切片加入的必要依赖称为该条指引和经该条适用，混淆编辑关联与原文交叉引用。',
    '明确第三十一条适用来自其自身不能正常运输且不能按票面乘车的条件；第四十三条原文只规定安置公告和证明，切片的必要依赖不是原法条指引。'],
  ['C10', 'PARTIAL', ['DOC0022-K02', 'DOC0022-K03', 'DOC0022-K08'],
    '机车车辆大修、维修样车投入运营前取证及目录对象转述基本准确；但必要DOC0015-K03未召回，就称整个库没有牵引供电产品许可规定，扩大了检索缺证范围。维修许可条件简写亦不能当作完整申请清单。',
    '补召回铁路运输基础设备定义及许可条款，分别界定地面牵引供电设备生产与机车车辆大修许可；未获完整必要证据时只说明本次检索不足。'],
  ['H06', 'PASS', ['DOC0016-K32', 'DOC0016-K55'],
    '2026文件编号、印发与施行日期和替代2023版的信息见所引切片版本及第五十五条；第三十二条5日送达报告、收到检验结果通知单起15日异议与第五十三条自然日及节假日顺延规则对应。没有将报告送达与异议起算材料混同。',
    '存档文本语义无待修正项；元数据仍须与官方原件独立复核，不据此证明截至核验日无后续变更。'],
  ['H07', 'PASS', ['DOC0022-K21', 'DOC0022-K22', 'DOC0014-K17', 'DOC0014-K18', 'DOC0015-K12', 'DOC0015-K13'],
    '区分地址名称变化的30个工作日变更及有效期不变，与变更地址造成许可条件变化时重新申请；未将一切搬迁都写成相同手续。存档版本边界及基础设备许可不是同一事项的说明明确。',
    '存档文本语义无待修正项；2013文本当前效力仍是单独核验事项。'],
  ['H08', 'PASS', ['DOC0005-K24', 'DOC0005-K19', 'DOC0004-K31', 'DOC0004-K43'],
    '现场改变时的标记、示意图、视听资料和书面记录并列保留，与抢修义务区分；旅客退改票仍限定在第三十一条所列不能正常运输且不能按票面乘车情形，没有把抢修理解为退票免责。',
    '存档文本语义无待修正项；现场视听资料应沿用原条术语，现行版本与具体责任另行核验。'],
];

const normalize = text => text.normalize('NFC').replace(/\s/gu, '');
const expectedCache = new Map();
const sourceCache = new Map();
assert.equal(new Set(judgments.map(item => item[0])).size, judgments.length);
const findings = [];
for (const [testID, status, pointIDs, finding, remedy] of judgments) {
  const question = inputs.questions.find(item => item.test_id === testID);
  const answer = answers.find(item => item.test_id === testID);
  assert.ok(question?.answerable, `${testID} is not an evidence question`);
  assert.ok(answer?.final_received && answer.answer, `${testID} missing final answer`);
  const evidence = [];
  for (const pointID of pointIDs) {
    const doc = docs.find(item => item.doc_id === pointID.split('-')[0]);
    assert.ok(doc, `${pointID} unknown document`);
    if (!expectedCache.has(doc.doc_id)) {
      expectedCache.set(doc.doc_id, await load(doc.structure_v3.expected_path));
    }
    const point = expectedCache.get(doc.doc_id).points.find(item => item.knowledge_point_id === pointID);
    assert.ok(point, `${pointID} missing source mapping`);
    const chunkIndex = answer.reference.chunks.findIndex(item => item.content.includes(pointID));
    assert.ok(chunkIndex >= 0, `${testID} lacks reference ${pointID}`);
    const chunk = answer.reference.chunks[chunkIndex];
    if (!sourceCache.has(point.source_path)) {
      sourceCache.set(point.source_path, await readFile(path.join(root, point.source_path)));
    }
    const sourceBytes = sourceCache.get(point.source_path);
    const attachment = path.extname(point.source_path).toLowerCase() === '.pdf';
    const isolatedDeletedProvision = pointID === 'DOC0005-K33'
      && point.source_body_retained === null
      && point.treatment === '带删除标记的历史金额隔离，原件保留，不冒充现行正文';
    if (!attachment) {
      assert.ok(normalize(sourceBytes.toString('utf8')).includes(normalize(point.source_body)),
        `${pointID} body absent from archived source`);
      if (isolatedDeletedProvision) {
        assert.ok(point.source_body.includes('2012年11月9日删除'));
        assert.ok(normalize(chunk.content).includes(normalize(point.body.replace(/\*\*/g, ''))),
          `${pointID} isolation notice absent from answer reference`);
        assert.ok(!chunk.content.includes('15万元') && !chunk.content.includes('2000元'),
          `${pointID} deleted historical amounts leaked into current reference`);
      } else {
        assert.ok(normalize(chunk.content).includes(normalize(point.source_body)),
          `${pointID} body absent from answer reference`);
      }
    }
    evidence.push({ knowledge_point_id: pointID, source_id: doc.source_id,
      source_path: point.source_path, source_sha256: hash(sourceBytes),
      chunk_id: chunk.id, reference_position: chunkIndex + 1,
      reference_sha256: hash(chunk.content),
      source_location: chunk.content.split('\n').find(line => line.includes(pointID)),
      archived_source_body_verified: attachment ? null : true,
      historical_provision_isolated: isolatedDeletedProvision,
      attachment_visual_review_completed: attachment ? false : null });
  }
  findings.push({ test_id: testID, domain: question.domain, question: question.question,
    status, findings: finding, remedy, evidence, answer_sha256: hash(answer.answer),
    raw_path: answer.raw_path,
    scope: '存档原文范围内的回答主张、语义和所列条款核对；不是现行法规效力认定或原应用修复后复测',
    final_acceptance_passed: false });
}
const report = {
  review_type: 'agent_semantic_review_against_archived_sources',
  inputs_path: inputsPath, inputs_sha256: hash(inputsBytes),
  answers_path: answersPath, answers_sha256: hash(answersBytes),
  evidence_questions_total: inputs.questions.filter(item => item.answerable).length,
  reviewed_evidence_questions: findings.length,
  pending_test_ids: inputs.questions.filter(item => item.answerable
    && !findings.some(finding => finding.test_id === item.test_id)).map(item => item.test_id),
  status_counts: Object.fromEntries(['PASS', 'PARTIAL', 'FAIL'].map(status =>
    [status, findings.filter(item => item.status === status).length])),
  all_question_final_citation_audit_completed: false,
  current_legal_effect_verified: false,
  original_answers_modified: false, user_app_modified: false,
  findings,
};
if (check) {
  const stored = await load(reportPath);
  const { checked_at: checkedAt, ...comparable } = stored;
  assert.ok(checkedAt);
  assert.deepEqual(comparable, report);
} else {
  await save(reportPath, { checked_at: new Date().toISOString(), ...report });
  await save('00-control/evidence-semantic-review-v3.md', '# 有证据回答语义复核\n\n' +
    `已复核${findings.length}/${report.evidence_questions_total}题：` +
    `PASS ${report.status_counts.PASS}，PARTIAL ${report.status_counts.PARTIAL}，FAIL ${report.status_counts.FAIL}。` +
    'PASS仅指存档文本范围内本轮所审查的回答主张，不是版本效力、完整检索或最终验收通过。\n\n' +
    table(['题号', '存档语义审查', '核验发现', '核验条款', '修正要求'],
      findings.map(item => [item.test_id, item.status, item.findings,
        item.evidence.map(e => e.knowledge_point_id).join('、'), item.remedy])) +
    '\n## 仍未完成\n' +
    `- 待审题号：${report.pending_test_ids.join('、') || '无（仍需处理失败项及最终验收）'}。\n` +
    '- 无证据题专项结果保留在no-evidence-semantic-review-v3.json，不与本表混算。\n' +
    '- 原始70份回答及SSE不改写；逐题原回答哈希、来源和引用哈希见05-review/evidence-semantic-review-v3.json。\n' +
    '- 必要证据在回答上下文出现不代表Top5检索命中；两个成绩分别报告。\n' +
    '- 法规版本效力、复杂附件视觉核验、原应用重排服务及独立留出集复测仍是单独的验收事项。\n');
}
assert.equal(hash(await readFile(path.join(root, answersPath))), hash(answersBytes));
console.log(JSON.stringify({ mode: check ? 'check' : 'write',
  reviewed: findings.length, total: report.evidence_questions_total,
  statuses: report.status_counts, pending: report.pending_test_ids.length,
  original_answers_unchanged: true, remote_mutation: false }));
