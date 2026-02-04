// Mock for @radix-ui/react-progress
const React = require('react');

const Root = React.forwardRef(({ children, className, value, max = 100, ...props }, ref) => {
  return React.createElement('div', {
    ref,
    className,
    role: 'progressbar',
    'aria-valuenow': value,
    'aria-valuemax': max,
    'data-state': value === max ? 'complete' : 'loading',
    'data-value': value,
    'data-max': max,
    ...props
  }, children);
});
Root.displayName = 'Progress';

const Indicator = React.forwardRef(({ className, style, ...props }, ref) => {
  return React.createElement('div', {
    ref,
    className,
    'data-state': 'loading',
    style,
    ...props
  });
});
Indicator.displayName = 'ProgressIndicator';

module.exports = {
  Root,
  Indicator,
};
