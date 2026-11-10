# Contribution guidelines

This document explains how to contribute to this repository, whether you are:

- A member of the team that owns the service,
- Contributing from another team or service within the organisation,
- New to the repository, or
- Contributing from outside the organisation.

The aim is to make it clear how to propose changes, develop and test them, and get them reviewed.

## Before contributing

### Proposing changes for third parties
Any ideas on the user journeys and general service experience you may have **should be first consulted
with us by submitting a new issue** to this repository. Ideas are always welcome, but if something is divergent or unrelated
to what we're trying to achieve we won't be able to accept it. Please keep this in mind as we don't want to waste anybody's time.

In the interest of creating a friendly collaboration environment, please read and adhere to an open source contributor's
[code of conduct](http://contributor-covenant.org/version/1/4/).

### Understanding the repository

Before making a change, it may be useful to review our technical documentation. In particular:
- [How to replicate pipeline tests and checks locally](https://hmcts.github.io/cloud-native-platform/guides/local-development.html)
- [How GitHub labels change pipeline behaviour](https://github.com/hmcts/cnp-jenkins-library#pr-label-behaviour)
- [Continuous Delivery](https://hmcts.github.io/standards/principles/continuous-delivery.html)

## Making a contribution

All changes must be reviewed before they are merged into the main branch. Direct changes to the main branch are not permitted.

Here's what you should do:
1. For third parties, [fork](https://help.github.com/articles/fork-a-repo/) this repository and clone it to your machine. If you are a member of the service team, there's no need to fork.
2. Create a new branch for your change:
   * use the latest *master* to branch from,
3. Implement the change in your branch:
   * if the change is non-trivial it's a good practice to split it into several logically independent units and deliver
   each one as a separate commit,
   * make sure the commit messages use proper language and accurately describe commit's content, e.g. *"Unify postcode lookup elements spacing"*.
   More information on good commit messages can be found [here](http://chris.beams.io/posts/git-commit/),
4. Test if your feature works as expected and does not break any existing features, this may include implementing additional automated tests or amending existing ones,
5. Push the change to your GitHub fork,
6. Submit a [pull request](https://help.github.com/articles/creating-a-pull-request-from-a-fork/) to our repository:
   * ensure that the pull request and related GitHub issue reference each other.

At this point the pull request will wait for someone from our team to review. It may be accepted straight away,
or we may ask you to make some additional amendments before incorporating it into the main branch.
