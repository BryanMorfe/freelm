import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToolPrompts } from '../../components/ToolPrompts';
import type { UserQuestion } from '../../lib/interaction-tools';

const questions: UserQuestion[] = [
	{
		id: 'layout',
		question: 'How should the notebook open when there are no saved boards?',
		options: [
			{
				label: 'Show an empty board',
				description: 'Start with a clean canvas and a visible import action.',
			},
			{
				label: 'Show a short introduction',
				description: 'Explain how to import images and arrange notes.',
			},
			{ label: 'Open a sample board', description: 'Provide a small example that users can edit.' },
		],
	},
	{
		id: 'navigation',
		question: 'Which navigation style should the narrow layout use?',
		options: [{ label: 'Collapsible sidebar' }, { label: 'Compact toolbar' }],
	},
];
function QuestionPreview({
	multiple = false,
	selected = false,
}: {
	multiple: boolean;
	selected: boolean;
}) {
	const [result, setResult] = useState('');
	const [answers, setAnswers] = useState<Record<string, string>>({});
	useEffect(() => {
		setAnswers(
			selected ? { layout: 'Show an empty board', navigation: 'Collapsible sidebar' } : {},
		);
		setResult('');
	}, [multiple, selected]);
	return (
		<div style={{ width: 'min(760px, 100%)' }}>
			<ToolPrompts
				key={`${multiple}:${selected}`}
				questions={{
					id: 'preview-question',
					questions: questions.slice(0, multiple ? 2 : 1),
					answer: (answers) =>
						setResult(
							Object.keys(answers).length
								? Object.values(answers)
										.map((value) => value.answers.join(', '))
										.join(' · ')
								: 'Skipped',
						),
				}}
				answers={answers}
				onAnswersChange={setAnswers}
			/>
			{result && (
				<p role="status" style={{ color: 'var(--muted)' }}>
					Preview response: {result}
				</p>
			)}
		</div>
	);
}
const meta = {
	title: 'Composer/Question sheet',
	component: QuestionPreview,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/ToolPrompts.tsx using src/components/tool-activity.css. Choose a suggested answer, write your own, skip, or minimize and reopen the sheet. Answers stay inside the story. The Selected story begins with a preselected answer and remains interactive.',
			},
		},
	},
	args: { multiple: false, selected: false },
} satisfies Meta<typeof QuestionPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SingleQuestion: Story = {};
export const MultipleQuestions: Story = { args: { multiple: true } };
export const Selected: Story = { args: { selected: true } };
