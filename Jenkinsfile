pipeline {
    // Assign this label only to the Jenkins agent on the API's server.
    agent { label 'hockeystats-server' }
    options {
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }
    triggers {
        githubPush()
        pollSCM('H/3 * * * *')
    }
    stages {
        stage('Test and deploy main') {
            steps {
                sh 'sudo -n -u chris_dev /usr/local/bin/deploy-hockeystatsapi "$GIT_COMMIT"'
            }
        }
    }
}
