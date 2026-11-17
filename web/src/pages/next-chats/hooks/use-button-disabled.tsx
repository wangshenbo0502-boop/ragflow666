import { trim } from 'lodash';
import { useParams } from 'react-router';

export const useGetSendButtonDisabled = () => {
  const { id: dialogId } = useParams();

  return dialogId === '';
};

export const useSendButtonDisabled = (
  value: string,
  hasAttachments = false,
) => {
  return trim(value) === '' && !hasAttachments;
};
